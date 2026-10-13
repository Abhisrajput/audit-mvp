import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { loadEngagement } from '../db/engagement-repo';
import { appendTrail } from '../db/trail-repo';
import type { Engagement, User } from '../engine/types';
import { insertGate, type Gate } from './gate-repo';
import { latestGateId, redraftBasis } from './graph';
import type { AgentPort } from './port';
import { reviewSubject } from './qa/deterministic';
import { appendStep, assertLease, type AgentRun } from './run-repo';
import { draftTestPlans } from './specialists/test-plan';
import type { DelegateRecord } from './state';
import { rowBasis, subjectInfo } from './subjects';
import type { Decision, Menu } from './types';

// Carries out one decision (spec §5.1, step 5). Specialists go through the AgentPort; QA reviews and gates are
// written here, each step together with its trail entry.

export interface ExecutorContext {
  db: Kysely<DB>;
  port: AgentPort;
  run: AgentRun;
  /** The person who started the run: the agent acts on their behalf. */
  starter: User;
  engagement: Engagement;
  gates: Gate[];
  menu: Menu;
}

export type Outcome =
  | { next: 'continue' }
  | { next: 'waiting'; reason: string }
  | { next: 'needs_human'; reason: string }
  | { next: 'completed' };

export async function applyDecision(ctx: ExecutorContext, decision: Decision): Promise<Outcome> {
  const { db, port, run, starter, engagement: e } = ctx;
  const a = decision.action;
  const event = (moduleId: string, agent: string, inputs: Record<string, unknown>, output: unknown) =>
    port.agentBundle(e, { moduleId, agent, runId: run.id, onBehalfOf: starter.id, inputs, output });

  switch (a.type) {
    case 'delegate':
    case 'rework': {
      const basis = redraftBasis(e, a.subjectKey, a.rows);
      const sinceGateId = latestGateId(ctx.gates, a.subjectKey);
      const acting = { runId: run.id, agent: a.specialist, startedBy: starter, leaseOwner: run.leaseOwner! };
      // Refuse before drafting anything if this worker has already lost the run.
      await db.transaction().execute((trx) => assertLease(trx, run.id, run.leaseOwner!));
      const started = Date.now();
      const { bundle } = a.specialist === 'test-plan'
        ? await port.saveTestPlans(e.id, draftTestPlans(e), acting, { expectedVersion: e.version! })
        : await port.runModule(e.id, a.specialist, acting, { expectedVersion: e.version!, rows: a.rows });
      const rowBases = a.subjectKey === 'gaps' && a.rows ? Object.fromEntries(a.rows.map((id) => [id, rowBasis(e, id)])) : undefined;
      const record: DelegateRecord = { action: a, basis, sinceGateId, bundleId: bundle.id, ...(rowBases ? { rowBases } : {}) };
      await db.transaction().execute(async (trx) => {
        await assertLease(trx, run.id, run.leaseOwner!);
        await appendStep(trx, run.id, {
          kind: 'delegate', agent: `specialist:${a.specialist}`, decision: record, model: bundle.provider.model,
          durationMs: Date.now() - started, trailBundleId: bundle.id,
        });
      });
      return { next: 'continue' };
    }
    case 'request_qa': {
      const report = reviewSubject(e, a.subjectKey);
      await db.transaction().execute(async (trx) => {
        await assertLease(trx, run.id, run.leaseOwner!);
        const sealed = await appendTrail(trx, event('agent:qa', 'qa', { subjectKey: a.subjectKey, mode: a.mode }, report));
        await appendStep(trx, run.id, { kind: 'qa', agent: 'qa', decision: report, model: report.reviewer, trailBundleId: sealed.id });
      });
      return { next: 'continue' };
    }
    case 'open_gate': {
      const s = subjectInfo(e, a.subjectKey);
      const kind = s?.gateKind;
      if (!s || !kind) throw new Error(`${a.subjectKey} has no gate`);
      const qa = ctx.menu.qa;
      if (!qa || qa.subjectKey !== s.key || qa.subjectHash !== s.hash) throw new Error(`${a.subjectKey} has no QA report for its current content`);
      await db.transaction().execute(async (trx) => {
        // Lock order is engagement, then run, then gate.
        await loadEngagement(trx, e.id, { forUpdate: true });
        await assertLease(trx, run.id, run.leaseOwner!);
        const gate = await insertGate(trx, {
          engagementId: e.id, runId: run.id, kind, subjectKey: s.key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, qaReport: qa,
        });
        const opened = { gateId: gate.id, kind, subjectId: gate.subjectId, subjectHash: gate.subjectHash, attempt: gate.attempt };
        const sealed = await appendTrail(trx, event('agent:gate-open', 'supervisor', { subjectKey: s.key }, opened));
        await appendStep(trx, run.id, { kind: 'tool_call', agent: 'supervisor', decision: { tool: 'open_gate', ...opened }, trailBundleId: sealed.id });
      });
      return { next: 'waiting', reason: `awaiting ${kind} gate signature` };
    }
    case 'wait':
      return { next: 'waiting', reason: a.reason };
    case 'escalate':
      return { next: 'needs_human', reason: a.reason };
    case 'complete':
      return { next: 'completed' };
  }
}
