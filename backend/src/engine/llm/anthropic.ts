import Anthropic, { APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { GenerateRequest, GenerateResult, LlmProvider } from './provider';
import { DEFAULT_MAX_TOKENS, MalformedOutputError, ModelStoppedError, ModelTimeoutError } from './provider';

/** Claude Haiku has no server-side refusal fallback; the other current models accept `fallbacks: 'default'`. */
export const acceptsServerFallback = (model: string) => !model.includes('haiku');

/** The beta that structured outputs need. `messages.parse()` adds it by itself; `messages.create()` does not. */
const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15';
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The parts of a beta message the provider reads. */
export type MessagesResponse = Pick<Anthropic.Beta.BetaMessage, 'content' | 'model' | 'stop_reason'> & {
  usage: Pick<Anthropic.Beta.BetaUsage, 'input_tokens' | 'output_tokens'>;
};

/** The one SDK call the provider makes. An Anthropic client is one; tests pass a stub. */
export interface MessagesClient {
  beta: { messages: { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<MessagesResponse> } };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client: MessagesClient;

  constructor(readonly model = 'claude-opus-5-5', client?: MessagesClient) {
    this.client = client ?? new Anthropic();
  }

  /**
   * One structured call. The answer is checked here rather than by `messages.parse()`, which parses before the stop
   * reason can be read and throws one generic error for a refusal, a truncation and an off-schema answer alike. So:
   * a refusal or truncation throws ModelStoppedError, an answer that is not the schema's JSON throws
   * MalformedOutputError, a timeout or abort throws ModelTimeoutError, each carrying what the caller needs to charge it.
   * Any other error (the API's own, or a connection that never got through) is passed on unchanged.
   */
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const model = req.model ?? this.model;
    const fallback = acceptsServerFallback(model);
    let response: MessagesResponse;
    try {
      response = await this.client.beta.messages.create(
        {
          model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          // If the primary model declines, the API re-runs the request on its
          // recommended fallback model; the served model is recorded in the trail.
          betas: fallback ? [SERVER_FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA] : [STRUCTURED_OUTPUTS_BETA],
          fallbacks: fallback ? 'default' : undefined,
          thinking: { type: 'adaptive' },
          output_config: { effort: req.effort ?? 'high', format: betaZodOutputFormat(req.schema) },
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        { ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}), ...(req.sdkRetries !== undefined ? { maxRetries: req.sdkRetries } : {}) },
      );
    } catch (err) {
      // Sent but not answered in time: the server may still run the request and bill it.
      if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
        throw new ModelTimeoutError(`Model call timed out or was aborted: ${err.message}`);
      }
      throw err;
    }

    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === 'refusal') {
      throw new ModelStoppedError('Model declined the request; no draft produced.', 'refusal', usage);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ModelStoppedError('Model output was truncated (max_tokens); no draft produced.', 'max_tokens', usage);
    }
    // The first text block is the answer, as messages.parse() reads it; adaptive thinking comes before it.
    const text = response.content.find((b) => b.type === 'text');
    if (!text) throw new MalformedOutputError('Model answered without any text.', usage);
    let output: T;
    try {
      const parsed = req.schema.safeParse(JSON.parse(text.text));
      if (!parsed.success) throw new Error(parsed.error.message);
      output = parsed.data;
    } catch (err) {
      throw new MalformedOutputError(`Model output did not match the required schema: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000), usage);
    }
    return { output, servedModel: response.model, usage };
  }
}
