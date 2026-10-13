import crypto from 'node:crypto';
import { sql, type Selectable, type Updateable } from 'kysely';
import type { AgentRunsTable, AgentStepsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import { supersedeOpenGates } from './gate-repo';
import { TERMINAL_STATUSES, type Budget, type RunStatus, type Spent, type StepKind } from './types';

// Agent runs and their steps (spec §3.1, §6). While a worker holds a run's lease it is the run's only writer; people
// change a run only through the transitions below, each refused when the run is in the wrong state. An ended run is
// locked by the database (migration 010).

export interface AgentRun {
  id: string;
  engagementId: string;
  goal: 'engagement';
  status: RunStatus;
  statusReason: string;
  policy: 'llm' | 'rules';
  policyVersion: string;
  budget: Budget;
  spent: Spent;
  startedBy: string;
  cancelRequested: boolean;
  pauseRequested: boolean;
  failureStreak: number;
  conflictStreak: number;
  wakeAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const isoOrNull = (d: Date | string | null) => (d ? iso(d) : null);
const now = () => new Date().toISOString();

function toRun(r: Selectable<AgentRunsTable>): AgentRun {
  return {
    id: r.id, engagementId: r.engagement_id, goal: r.goal, status: r.status, statusReason: r.status_reason, policy: r.policy,
    policyVersion: r.policy_version, budget: r.budget, spent: r.spent, startedBy: r.started_by, cancelRequested: r.cancel_requested,
    pauseRequested: r.pause_requested, failureStreak: r.failure_streak, conflictStreak: r.conflict_streak, wakeAt: isoOrNull(r.wake_at),
    leaseOwner: r.lease_owner, leaseUntil: isoOrNull(r.lease_until), version: r.version, createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at), endedAt: isoOrNull(r.ended_at),
  };
}

export const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

export async function createRun(
  db: Executor,
  p: { engagementId: string; startedBy: string; policy: 'llm' | 'rules'; policyVersion: string; budget: Budget },
): Promise<AgentRun> {
  try {
    const row = await db
      .insertInto('agent_runs')
      .values({
        id: `AR-${crypto.randomBytes(6).toString('hex')}`, engagement_id: p.engagementId, status: 'runnable', policy: p.policy,
        policy_version: p.policyVersion, budget: JSON.stringify(p.budget), started_by: p.startedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRun(row);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, `Engagement ${p.engagementId} already has an active agent run`, 'RUN_ACTIVE');
    throw err;
  }
}

export async function getRun(db: Executor, id: string, opts: { forUpdate?: boolean } = {}): Promise<AgentRun | null> {
  let q = db.selectFrom('agent_runs').selectAll().where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toRun(row) : null;
}

/** The engagement's runs, newest first. */
export async function listRuns(db: Executor, engagementId: string): Promise<AgentRun[]> {
  const rows = await db.selectFrom('agent_runs').selectAll().where('engagement_id', '=', engagementId).orderBy('created_at', 'desc').orderBy('id').execute();
  return rows.map(toRun);
}

/** Takes one due run: runnable, waiting past its wake time, or running with an expired lease (its worker died). */
export async function leaseNext(db: Executor, owner: string, leaseMs: number): Promise<AgentRun | null> {
  const { rows } = await sql<Selectable<AgentRunsTable>>`
    UPDATE agent_runs
    SET status = 'running', lease_owner = ${owner}, lease_until = now() + ${leaseMs}::int * interval '1 millisecond',
        wake_at = NULL, updated_at = now(), version = version + 1
    WHERE id = (
      SELECT id FROM agent_runs
      WHERE status = 'runnable'
         OR (status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= now())
         OR (status = 'running' AND lease_until < now())
      ORDER BY updated_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING *`.execute(db);
  return rows[0] ? toRun(rows[0]) : null;
}

/** Extends the lease while an iteration is still working. False when another worker has taken the run. */
export async function renewLease(db: Executor, id: string, owner: string, leaseMs: number): Promise<boolean> {
  const res = await sql`
    UPDATE agent_runs SET lease_until = now() + ${leaseMs}::int * interval '1 millisecond'
    WHERE id = ${id} AND lease_owner = ${owner} AND status = 'running'`.execute(db);
  return Number(res.numAffectedRows ?? 0) === 1;
}

export interface RunUpdate {
  status: RunStatus;
  reason?: string;
  wakeAt?: Date | null;
  spent?: Spent;
  failureStreak?: number;
  conflictStreak?: number;
  /** The worker acted on a pause request, so the request is cleared. */
  pauseHandled?: boolean;
}

/**
 * The leasing worker's last word on an iteration: the run's next status, and the lease released. A cancel or pause asked
 * for while the iteration ran turns the run runnable instead, so the next tick acts on it. False when the lease was lost.
 */
export async function releaseRun(db: Executor, id: string, owner: string, u: RunUpdate): Promise<boolean> {
  const terminal = isTerminal(u.status);
  const pauseHandled = u.pauseHandled ?? false;
  const res = await sql`
    UPDATE agent_runs SET
      status = CASE WHEN NOT ${terminal}::boolean AND (cancel_requested OR (pause_requested AND NOT ${pauseHandled}::boolean))
               THEN 'runnable' ELSE ${u.status}::text END,
      status_reason = CASE WHEN NOT ${terminal}::boolean AND (cancel_requested OR (pause_requested AND NOT ${pauseHandled}::boolean))
               THEN '' ELSE ${u.reason ?? ''}::text END,
      pause_requested = CASE WHEN ${pauseHandled}::boolean THEN false ELSE pause_requested END,
      wake_at = ${u.wakeAt ? u.wakeAt.toISOString() : null}::timestamptz,
      spent = COALESCE(${u.spent ? JSON.stringify(u.spent) : null}::jsonb, spent),
      failure_streak = COALESCE(${u.failureStreak ?? null}::int, failure_streak),
      conflict_streak = COALESCE(${u.conflictStreak ?? null}::int, conflict_streak),
      lease_owner = NULL, lease_until = NULL, updated_at = now(), version = version + 1,
      ended_at = CASE WHEN ${terminal}::boolean THEN now() ELSE NULL END
    WHERE id = ${id} AND lease_owner = ${owner} AND status = 'running'`.execute(db);
  return Number(res.numAffectedRows ?? 0) === 1;
}

async function lockedLiveRun(db: Executor, id: string): Promise<AgentRun> {
  const run = await getRun(db, id, { forUpdate: true });
  if (!run) throw new AppError(404, `Agent run ${id} not found`);
  if (isTerminal(run.status)) throw new AppError(409, `Agent run ${id} has ended (${run.status})`);
  return run;
}

async function updateRun(db: Executor, id: string, set: Updateable<AgentRunsTable>): Promise<AgentRun> {
  const row = await db
    .updateTable('agent_runs')
    .set({ ...set, updated_at: now(), version: sql<number>`version + 1` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRun(row);
}

/** Cancels at once when no worker holds the run (its open gates are superseded); otherwise on the worker's next look. */
export async function requestCancel(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running') return updateRun(db, id, { cancel_requested: true });
  await supersedeOpenGates(db, id);
  return updateRun(db, id, { status: 'cancelled', status_reason: 'cancelled_by_user', wake_at: null, ended_at: now() });
}

/** Pauses at once when no worker holds the run; otherwise on the worker's next look. A paused run waits until resumed. */
export async function requestPause(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running') return updateRun(db, id, { pause_requested: true });
  return updateRun(db, id, { status: 'waiting', status_reason: 'paused_by_user', wake_at: null });
}

/** Resumes a waiting or escalated run. */
export async function markRunnable(db: Executor, id: string): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  if (run.status === 'running' || run.status === 'runnable') throw new AppError(409, `Agent run ${id} is already ${run.status}`);
  return updateRun(db, id, { status: 'runnable', status_reason: '', pause_requested: false, failure_streak: 0, conflict_streak: 0, wake_at: null });
}

/** Sets a new budget. A run stopped by its budget resumes. */
export async function setRunBudget(db: Executor, id: string, budget: Budget): Promise<AgentRun> {
  const run = await lockedLiveRun(db, id);
  const resume = run.status === 'needs_human' && run.statusReason.startsWith('budget_exhausted');
  return updateRun(db, id, { budget: JSON.stringify(budget), ...(resume ? { status: 'runnable' as const, status_reason: '' } : {}) });
}

/** Any change to the engagement wakes its waiting run, which then re-derives where it stands. A paused run stays paused. */
export async function wakeWaitingRuns(db: Executor, engagementId: string): Promise<void> {
  await db
    .updateTable('agent_runs')
    .set({ status: 'runnable', status_reason: '', wake_at: null, updated_at: now(), version: sql<number>`version + 1` })
    .where('engagement_id', '=', engagementId)
    .where('status', '=', 'waiting')
    .where('status_reason', '<>', 'paused_by_user')
    .execute();
}

// ---------- Steps ----------

export interface StepDraft {
  kind: StepKind;
  agent: string;
  decision: unknown;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  trailBundleId?: string | null;
}

export interface AgentStep {
  runId: string;
  seq: number;
  kind: StepKind;
  agent: string;
  decision: unknown;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  trailBundleId: string | null;
  createdAt: string;
}

const toStep = (r: Selectable<AgentStepsTable>): AgentStep => ({
  runId: r.run_id, seq: r.seq, kind: r.kind, agent: r.agent, decision: r.decision, model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  costUsd: r.cost_usd, durationMs: r.duration_ms, trailBundleId: r.trail_bundle_id, createdAt: iso(r.created_at),
});

/** Appends the run's next step. Only the run's leaseholder appends, so seq does not race; the primary key backs that up. */
export async function appendStep(db: Executor, runId: string, d: StepDraft): Promise<AgentStep> {
  const last = await db.selectFrom('agent_steps').select((eb) => eb.fn.max('seq').as('seq')).where('run_id', '=', runId).executeTakeFirst();
  const row = await db
    .insertInto('agent_steps')
    .values({
      run_id: runId, seq: Number(last?.seq ?? 0) + 1, kind: d.kind, agent: d.agent, decision: JSON.stringify(d.decision), model: d.model ?? null,
      tokens_in: d.tokensIn ?? 0, tokens_out: d.tokensOut ?? 0, cost_usd: d.costUsd ?? 0, duration_ms: d.durationMs ?? 0, trail_bundle_id: d.trailBundleId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toStep(row);
}

export async function listSteps(db: Executor, runId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<AgentStep[]> {
  const rows = await db
    .selectFrom('agent_steps')
    .selectAll()
    .where('run_id', '=', runId)
    .where('seq', '>', opts.afterSeq ?? 0)
    .orderBy('seq')
    .limit(opts.limit ?? 10_000)
    .execute();
  return rows.map(toStep);
}
