import crypto from 'node:crypto';
import os from 'node:os';
import { PREPARER_ROLES } from '../auth/roles';
import { getUser } from '../auth/user-repo';
import { loadEngagement } from '../db/engagement-repo';
import { appendTrail, type Executor } from '../db/trail-repo';
import type { User } from '../engine/types';
import { AppError } from '../errors';
import { runWithRequestId } from '../observability/context';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { addSpend, budgetProblem, ModelMeter } from './budget';
import type { AgentConfig } from './config';
import { AgentModels } from './llm/models';
import { applyDecision, type Outcome } from './executor';
import { listGates, supersedeOpenGates } from './gate-repo';
import { allowedActions } from './graph';
import { elapsedMs, observeSteps } from './metrics';
import { LlmPolicy } from './policy/llm';
import { RulesPolicy } from './policy/rules';
import { agentPort, type AgentPort } from './port';
import { appendStep, assertLease, lastStepSeq, leaseNext, listSteps, recordSpend, releaseRun, renewLease, type AgentRun, type LeasedRun, type RunUpdate } from './run-repo';
import { loadGraphInput, reconcileGates } from './state';
import { DecisionSchema, sameAction, type Decision, type Menu, type Policy, type Spent } from './types';

// The agent worker (spec §2, §6). One tick leases one due run, takes one step of its loop, and hands the run back with
// its next status. Everything is derived again from the database each tick, so a worker that dies loses at most one
// uncommitted step, and another worker picks the run up once the lease runs out.

const CONFLICT_BACKOFF_MS = 60_000;
const MAX_STREAK = 3;

/** The decision for this menu: forced when one action is allowed, else the policy's, else (off the menu) the rules'. */
export async function chooseDecision(policy: Policy, menu: Menu, models?: AgentModels): Promise<Decision> {
  if (menu.actions.length === 1) return { action: menu.actions[0], rationale: 'The only allowed action', policy: 'forced', policyVersion: policy.version };
  const proposed = await policy.decide(menu, models);
  const parsed = DecisionSchema.safeParse(proposed);
  if (parsed.success && menu.actions.some((a) => sameAction(a, parsed.data.action))) return parsed.data;
  // A last line of defence: whatever a policy returns, only a menu entry is ever applied.
  const fallback = await new RulesPolicy().decide(menu);
  return {
    ...fallback,
    rationale: `${fallback.rationale} (the ${policy.kind} policy chose an action that is not allowed)`.slice(0, 500),
    attempts: [...(parsed.success ? parsed.data.attempts ?? [] : []), { outcome: 'off_menu', model: null, detail: 'the policy returned an action that is not on the menu' }],
  };
}

const statusOf = (o: Outcome): Pick<RunUpdate, 'status' | 'reason'> =>
  o.next === 'continue' ? { status: 'runnable' } : o.next === 'completed' ? { status: 'completed' } : { status: o.next, reason: o.reason };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WorkerOptions {
  id?: string;
  policy?: Policy;
  /** Waits between retries of a failing model call (tests pass one that does not wait). */
  wait?: (ms: number) => Promise<void>;
}

export class AgentWorker {
  readonly id: string;
  private readonly policy: Policy;
  private readonly port: AgentPort;
  private readonly wait?: (ms: number) => Promise<void>;
  private stopping = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly svc: AuditService, private readonly cfg: AgentConfig, opts: WorkerOptions = {}) {
    this.id = opts.id ?? `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    // A deployment with a model provider decides with the model; one without uses the rules (Ruling 7).
    this.policy = opts.policy ?? (svc.llm ? new LlmPolicy() : new RulesPolicy());
    this.port = agentPort(svc);
    this.wait = opts.wait;
  }

  /** Leases one due run and takes one step of it. 'idle' when switched off or nothing is due. */
  async tick(): Promise<'idle' | 'worked'> {
    if (!this.cfg.enabled) return 'idle';
    const db = this.svc.db.kysely;
    const run = await leaseNext(db, this.id, this.cfg.leaseMs);
    if (!run) return 'idle';
    const heartbeat = setInterval(() => {
      renewLease(db, run.id, this.id, this.cfg.leaseMs)
        .then((held) => { if (!held) logger.warn({ runId: run.id }, "lease lost; this iteration's writes will be refused"); })
        .catch((err) => logger.warn({ err, runId: run.id }, 'agent lease renewal failed'));
    }, this.cfg.heartbeatMs);
    try {
      // Steps are counted once committed and only by the worker that hands the run back (spec §6.4). They are listed
      // while this worker still holds the run, so no step written after a takeover is counted here as well.
      const fromSeq = await lastStepSeq(db, run.id).catch(() => null);
      const update = await runWithRequestId(run.id, () => this.iterate(run));
      const committed = fromSeq === null ? [] : await listSteps(db, run.id, { afterSeq: fromSeq }).catch(() => []);
      if (await releaseRun(db, run.id, this.id, update)) observeSteps(committed, this.cfg.llm);
      else logger.warn({ runId: run.id }, 'agent run lease was lost before the step was handed back');
    } finally {
      clearInterval(heartbeat);
    }
    return 'worked';
  }

  /** Ticks until nothing is due (tests, and one-off runs from the command line). */
  async drain(maxTicks = 1000): Promise<number> {
    let ticks = 0;
    while (ticks < maxTicks && (await this.tick()) === 'worked') ticks++;
    return ticks;
  }

  /** Polls in the background with `concurrency` loops. */
  start(): void {
    this.stopping = false;
    for (let i = 0; i < this.cfg.concurrency; i++) {
      this.loops.push((async () => {
        while (!this.stopping) {
          const result = await this.tick().catch((err) => {
            logger.error({ err }, 'agent worker tick failed');
            return 'idle' as const;
          });
          if (result === 'idle' && !this.stopping) await sleep(this.cfg.pollMs);
        }
      })());
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops.splice(0));
  }

  private async iterate(run: LeasedRun): Promise<RunUpdate> {
    const db = this.svc.db.kysely;
    // Every model call this iteration makes is charged through the meter and written to the run as it happens.
    const meter = new ModelMeter(run.budget, run.spent, (spent) => db.transaction().execute((trx) => recordSpend(trx, run.id, this.id, spent)));
    const models = new AgentModels(this.svc.llm, this.cfg.llm, meter, this.wait ? { wait: this.wait } : {});
    try {
      // Lock order is engagement, then run, then gate, everywhere; a worker whose lease has lapsed writes nothing.
      if (run.cancelRequested) {
        await db.transaction().execute(async (trx) => {
          await this.lockEngagement(trx, run);
          await assertLease(trx, run.id, this.id);
          await supersedeOpenGates(trx, run.id);
        });
        return { status: 'cancelled', reason: 'cancelled_by_user' };
      }
      if (run.pauseRequested) return { status: 'waiting', reason: 'paused_by_user', pauseHandled: true };
      if (run.takenOver) {
        // leaseNext has already counted the dead worker's step as a failed one; say so in the run's record.
        await db.transaction().execute(async (trx) => {
          await assertLease(trx, run.id, this.id);
          await appendStep(trx, run.id, {
            kind: 'tool_call', agent: 'worker',
            decision: { recovered: 'The worker holding this run stopped mid-step. That step was counted as failed, and is redone from the engagement as it is now.' },
          });
        });
        if (run.failureStreak >= MAX_STREAK) {
          return { status: 'needs_human', reason: `error: the worker running this run stopped mid-step ${run.failureStreak} times in a row` };
        }
      }
      const over = budgetProblem(run.budget, run.spent);
      if (over) return { status: 'needs_human', reason: over };
      const record = await getUser(db, run.startedBy);
      if (!record?.active || !record.role || !PREPARER_ROLES.includes(record.role)) {
        return { status: 'needs_human', reason: 'the person who started this run can no longer prepare audit work; start a new run' };
      }
      const starter: User = { id: record.id, name: record.name, role: record.role };
      const e = await db.transaction().execute(async (trx) => {
        const locked = await this.lockEngagement(trx, run);
        await assertLease(trx, run.id, this.id);
        await reconcileGates(trx, locked);
        return locked;
      });
      const gates = await listGates(db, e.id);
      const menu = allowedActions(await loadGraphInput(db, run, e, gates, this.cfg.qaThreshold));
      const deciding = Date.now();
      const decision = await chooseDecision(this.policy, menu, models);
      const decidedMs = elapsedMs(deciding);
      const used = models.take();
      const servedBy = [...(decision.attempts ?? [])].reverse().find((x) => x.model)?.model ?? decision.policyVersion;
      await db.transaction().execute(async (trx) => {
        await assertLease(trx, run.id, this.id);
        const sealed = await appendTrail(trx, this.port.agentBundle(e, {
          moduleId: 'agent:decision', agent: 'supervisor', runId: run.id, onBehalfOf: starter.id,
          provider: { id: decision.policy, model: servedBy }, inputs: { stage: menu.stage, menu: menu.actions }, output: decision,
        }));
        await appendStep(trx, run.id, {
          kind: 'decision', agent: 'supervisor', decision, model: used.model ?? decision.policyVersion,
          tokensIn: used.tokensIn, tokensOut: used.tokensOut, costUsd: used.costUsd, durationMs: decidedMs, trailBundleId: sealed.id,
        });
      });
      const outcome = await applyDecision({
        db, port: this.port, run, starter, engagement: e, gates, menu, models,
        checks: { registry: this.svc.registry, policy: this.svc.citationPolicy },
      }, decision);
      return { ...statusOf(outcome), spent: addSpend(meter.spent, { steps: 1 }), failureStreak: 0, conflictStreak: 0 };
    } catch (err) {
      return this.failed(run, err, meter.spent);
    }
  }

  /** Locks the run's engagement row for the rest of the transaction and returns it. */
  private async lockEngagement(trx: Executor, run: AgentRun) {
    const loaded = await loadEngagement(trx, run.engagementId, { forUpdate: true });
    if (!loaded) throw new AppError(404, `Engagement ${run.engagementId} not found`);
    return loaded.engagement;
  }

  private async failed(run: AgentRun, err: unknown, spentSoFar: Spent): Promise<RunUpdate> {
    // A failed iteration still counts as a step against the budget, so a run that keeps failing cannot go on forever.
    // Model calls it made are already in `spentSoFar` (the meter wrote them as they happened).
    const spent = addSpend(spentSoFar, { steps: 1 });
    // Another worker holds the run now; hand it back without touching its streaks (releasing will do nothing).
    if (err instanceof AppError && err.code === 'LEASE_LOST') return { status: 'runnable' };
    // A model call the budget could not cover was refused before it was made (spec §6.1): a person decides.
    if (err instanceof AppError && err.code === 'BUDGET_EXHAUSTED') return { status: 'needs_human', reason: err.message, spent };
    if (err instanceof AppError && err.code === 'VERSION_CONFLICT') {
      const streak = run.conflictStreak + 1;
      if (streak < MAX_STREAK) return { status: 'runnable', conflictStreak: streak, spent };
      return { status: 'waiting', reason: 'engagement being edited', wakeAt: new Date(Date.now() + CONFLICT_BACKOFF_MS), conflictStreak: 0, spent };
    }
    if (err instanceof AppError && err.code === 'AGENT_FORBIDDEN') {
      logger.warn({ runId: run.id, refused: err.message }, 'agent action refused by the rails');
      try {
        await this.svc.db.kysely.transaction().execute(async (trx) => {
          await assertLease(trx, run.id, this.id);
          await appendStep(trx, run.id, { kind: 'tool_call', agent: 'rails', decision: { refused: err.message } });
        });
      } catch (stepErr) {
        if (stepErr instanceof AppError && stepErr.code === 'LEASE_LOST') logger.warn({ runId: run.id }, 'could not record the refused action; the lease is gone');
        else logger.error({ runId: run.id, err: stepErr }, `could not record the refused action: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
      }
      return { status: 'needs_human', reason: `agent_forbidden: ${err.message}`, spent };
    }
    if (err instanceof AppError && err.status === 404 && err.message.startsWith(`Engagement ${run.engagementId} `)) {
      return { status: 'failed', reason: `engagement ${run.engagementId} no longer exists` };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId: run.id, err }, 'agent run step failed');
    const streak = run.failureStreak + 1;
    if (streak < MAX_STREAK) return { status: 'runnable', failureStreak: streak, spent };
    return { status: 'needs_human', reason: `error: ${message}`.slice(0, 500), failureStreak: streak, spent };
  }
}
