import { z } from 'zod';
import { MalformedOutputError, ModelStoppedError, ModelTimeoutError, type GenerateRequest, type GenerateResult, type LlmProvider } from '../../engine/llm/provider';
import type { ModelMeter } from '../budget';
import type { AgentLlmConfig, ModelRole } from '../config';
import type { Spent } from '../types';
import { callCost, estimateCall, priceFor } from './prices';

// Every model call an agent makes goes through here (spec §6.1, §6.3). Each call is estimated and charged to the run
// before it is made, retried with backoff when the model fails, settled to what it used, and attributed to the step
// that asked for it (take()).

/** The waits before the three retries of a failing call. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** What calls cost since the last take(), for the step that made them. */
export interface ModelUse {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** The model that served the last call, or null when there was none. */
  model: string | null;
}

/** The model could not be reached, or kept failing: the caller falls back to its offline path, flagged. */
export class ModelUnavailableError extends Error {}

export interface ModelRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const none = (): ModelUse => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: null });

/**
 * Call generate() from outside any transaction: the meter takes its own lease-fenced transaction to write the run's
 * spend, so calling it while a transaction holds the run row would hang the worker.
 */
export class AgentModels {
  private used: ModelUse = none();
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly provider: LlmProvider | null,
    private readonly cfg: AgentLlmConfig,
    private readonly meter: ModelMeter,
    opts: { wait?: (ms: number) => Promise<void> } = {},
  ) {
    this.wait = opts.wait ?? sleep;
  }

  /** False offline (LLM_PROVIDER=offline): every agent then uses its rules. */
  get available(): boolean {
    return this.provider !== null;
  }

  /**
   * One structured call for a role. Throws BUDGET_EXHAUSTED before sending anything the budget cannot cover,
   * MalformedOutputError when the model answers in the wrong shape (the caller decides whether to ask again), and
   * ModelUnavailableError after three retries of a failing model. A lost lease (LEASE_LOST from the meter) is never
   * swallowed: it propagates, and the estimate stays charged.
   */
  async generate<T>(role: ModelRole, req: ModelRequest<T>): Promise<{ output: T; servedModel: string }> {
    const provider = this.provider;
    if (!provider) throw new ModelUnavailableError('No model is configured (LLM_PROVIDER=offline)');
    const s = this.cfg.roles[role];
    let last = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await this.wait(RETRY_DELAYS_MS[attempt - 1]);
      const estimate = estimateCall(this.cfg.prices, s.model, req.system.length + req.user.length, s.maxTokens);
      await this.meter.reserve(estimate);
      let res: GenerateResult<T>;
      try {
        res = await provider.generate({ ...req, model: s.model, maxTokens: s.maxTokens, effort: s.effort, timeoutMs: this.cfg.timeoutMs, sdkRetries: 0 });
      } catch (err) {
        if (err instanceof MalformedOutputError || err instanceof z.ZodError) {
          // The model answered, so the call was paid for: settle at what it used, or keep the estimate when the
          // provider could not say.
          const actual = err instanceof MalformedOutputError && err.usage ? this.actualOf(err.usage, s.model, s.model) : estimate;
          await this.meter.settle(estimate, actual);
          this.note(actual, s.model);
          if (err instanceof MalformedOutputError) throw err;
          throw new MalformedOutputError((err as Error).message);
        }
        if (err instanceof ModelStoppedError) {
          // A refusal or a truncation ran on the API and is billed: settle at what it used, and do not retry, since
          // a truncation would only repeat. The caller falls back like any other model failure.
          const actual = err.usage ? this.actualOf(err.usage, s.model, s.model) : estimate;
          await this.meter.settle(estimate, actual);
          this.note(actual, s.model);
          throw new ModelUnavailableError(`${s.model} stopped without an answer (${err.reason})`);
        }
        last = err instanceof Error ? err.message : String(err);
        if (err instanceof ModelTimeoutError) {
          // Sent, then timed out or aborted: the server may still finish and bill it, so the estimate stays charged
          // (an over-count at most, never an uncounted paid call). It is retried like any other model error.
          await this.meter.settle(estimate, estimate);
          this.note(estimate, s.model);
          continue;
        }
        // An error the API returned, or a connection that never got through, is not billed.
        await this.meter.settle(estimate, {});
        continue;
      }
      const actual = res.usage
        ? this.actualOf(res.usage, res.servedModel, s.model)
        : estimate;
      await this.meter.settle(estimate, actual);
      this.note(actual, res.servedModel);
      return { output: res.output, servedModel: res.servedModel };
    }
    throw new ModelUnavailableError(`${s.model} failed ${RETRY_DELAYS_MS.length + 1} times: ${last}`.slice(0, 500));
  }

  /**
   * A provider for the specialist modules (scope, RCM, testing, gaps, report). Each of their calls goes through
   * generate('specialist'), so it is charged and retried like any other. Null offline.
   */
  forModules(): LlmProvider | null {
    if (!this.provider) return null;
    const models = this;
    const settings = this.cfg.roles.specialist;
    return {
      id: this.provider.id,
      model: settings.model,
      async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
        return models.generate('specialist', { system: req.system, user: req.user, schema: req.schema });
      },
    };
  }

  /** What calls cost since the last take(); resets. */
  take(): ModelUse {
    const used = this.used;
    this.used = none();
    return used;
  }

  private actualOf(usage: { inputTokens: number; outputTokens: number }, served: string, asked: string) {
    return {
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      costUsd: callCost(priceFor(this.cfg.prices, served, asked), usage.inputTokens, usage.outputTokens),
    };
  }

  private note(s: Pick<Spent, 'tokensIn' | 'tokensOut' | 'costUsd'>, model: string) {
    this.used = {
      tokensIn: this.used.tokensIn + s.tokensIn,
      tokensOut: this.used.tokensOut + s.tokensOut,
      costUsd: Math.round((this.used.costUsd + s.costUsd) * 1e6) / 1e6,
      model,
    };
  }
}
