import { PREPARER_ROLES, REVIEWER_ROLES } from '../auth/roles';
import { loadEngagement } from '../db/engagement-repo';
import { appendTrail, type Executor } from '../db/trail-repo';
import type { User } from '../engine/types';
import { AppError } from '../errors';
import type { AuditService } from '../service';
import { lowerBudget } from './budget';
import type { AgentConfig } from './config';
import { RULES_VERSION } from './policy/rules';
import { createRun, getRun, markRunnable, requestCancel, requestPause, setRunBudget, type AgentRun } from './run-repo';
import type { Budget } from './types';

// What people do with agent runs (spec §4.6, §7.1). Each change is written to the trail with the run's new state.

function mayPrepare(actor: User) {
  if (!PREPARER_ROLES.includes(actor.role)) throw new AppError(403, `${actor.role} may not start or steer agent runs`);
}

/** An audit manager who starts a run cannot sign its scope or RCM gates (spec §4.3): say so, and say who can. */
async function starterWarnings(svc: AuditService, actor: User): Promise<string[]> {
  if (actor.role !== 'audit_manager') return [];
  const others = await svc.db.kysely
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('role', '=', 'audit_manager')
    .where('active', '=', true)
    .where('id', '<>', actor.id)
    .executeTakeFirstOrThrow();
  return [`You started this run, so you cannot sign its scope or RCM gates or review the findings it drafts. ${Number(others.n)} other active audit manager(s) can.`];
}

export async function startRun(svc: AuditService, cfg: AgentConfig, engagementId: string, actor: User, requested?: Partial<Budget>) {
  mayPrepare(actor);
  if (!cfg.enabled) throw new AppError(503, 'Agent runs are switched off (AGENT_ENABLED=false)', 'AGENT_DISABLED');
  const e = await svc.engagement(engagementId);
  const budget = lowerBudget(cfg.budget, requested);
  const run = await svc.db.kysely.transaction().execute(async (trx) => {
    const created = await createRun(trx, { engagementId, startedBy: actor.id, policy: 'rules', policyVersion: RULES_VERSION, budget });
    await appendTrail(trx, svc.humanBundle(e, 'human:agent-run-start', actor, { budget }, { runId: created.id }));
    return created;
  });
  return { run, warnings: await starterWarnings(svc, actor) };
}

async function change(svc: AuditService, runId: string, actor: User, moduleId: string, fn: (db: Executor) => Promise<AgentRun>): Promise<AgentRun> {
  const run = await getRun(svc.db.kysely, runId);
  if (!run) throw new AppError(404, `Agent run ${runId} not found`);
  return svc.db.kysely.transaction().execute(async (trx) => {
    // Lock order is engagement, then run, then gate (as in signGate and the worker); cancelling supersedes open gates.
    const loaded = await loadEngagement(trx, run.engagementId, { forUpdate: true });
    if (!loaded) throw new AppError(404, `Engagement ${run.engagementId} not found`);
    const e = loaded.engagement;
    const updated = await fn(trx);
    await appendTrail(trx, svc.humanBundle(e, moduleId, actor, { runId }, { status: updated.status, statusReason: updated.statusReason, budget: updated.budget }));
    return updated;
  });
}

export async function pauseRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-pause', (db) => requestPause(db, runId));
}

export async function resumeRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-resume', (db) => markRunnable(db, runId));
}

export async function cancelRun(svc: AuditService, runId: string, actor: User) {
  mayPrepare(actor);
  return change(svc, runId, actor, 'human:agent-run-cancel', (db) => requestCancel(db, runId));
}

/** An audit manager raises a run's budget; a run stopped by its budget resumes. A budget is never lowered here. */
export async function raiseBudget(svc: AuditService, runId: string, actor: User, budget: Budget) {
  if (!REVIEWER_ROLES.includes(actor.role)) throw new AppError(403, `${actor.role} may not raise an agent run's budget`);
  return change(svc, runId, actor, 'human:agent-run-budget', async (db) => {
    const run = (await getRun(db, runId))!;
    for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
      if (budget[k] < run.budget[k]) throw new AppError(400, `A budget can only be raised: ${k} is already ${run.budget[k]}`);
    }
    return setRunBudget(db, runId, budget);
  });
}
