import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { loadEngagement } from '../db/engagement-repo';
import { appendTrail } from '../db/trail-repo';
import type { Engagement, TrailBundle, User } from '../engine/types';
import { AppError } from '../errors';
import type { AgentModels } from './llm/models';
import { insertGate, type Gate } from './gate-repo';
import { latestGateId, redraftBasis } from './graph';
import type { AgentPort } from './port';
import { reviewWithAgent } from './qa/agent';
import type { QaChecks } from './qa/deterministic';
import { appendStep, assertLease, listSteps, type AgentRun, type AgentStep } from './run-repo';
import { draftTestPlansWithModel } from './specialists/test-plan';
import type { DelegateRecord } from './state';
import { rowBasis, rowOfKey, subjectInfo } from './subjects';
import { Toolbox } from './tools/toolbox';
import type { Decision, Menu, QaReport } from './types';

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
  /** This iteration's model access, charged to the run. Absent in offline tests: everything then runs on rules. */
  models?: AgentModels;
  /** The citation gate and trust rules for QA (engine/qa.ts, REQ-22). The worker always passes them. */
  checks?: QaChecks;
}

export type Outcome =
  | { next: 'continue' }
  | { next: 'waiting'; reason: string }
  | { next: 'needs_human'; reason: string }
  | { next: 'completed' };

/** When the subject's latest draft was made without the model (it was down), QA says so to the signer (spec §6.3). */
function flagDraftWithoutModel(report: QaReport, steps: AgentStep[]): QaReport {
  const rowId = rowOfKey(report.subjectKey);
  const last = [...steps].reverse().find((s) => {
    if (s.kind !== 'delegate') return false;
    const d = s.decision as DelegateRecord;
    return d.action.subjectKey === report.subjectKey || (!!rowId && !!d.rowBases && rowId in d.rowBases);
  });
  if (!(last?.decision as DelegateRecord | undefined)?.withoutModel) return report;
  return {
    ...report,
    issues: [...report.issues, { criterion: 'draft.without-model', severity: 'advisory', detail: 'Drafted without model: the model was unavailable, so the specialist used its offline rules' }],
  };
}

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
      // The specialist's model calls are the run's, charged through its meter; without models it runs on its rules.
      const llm = ctx.models?.forModules() ?? null;
      const instruction = a.type === 'rework' ? a.instruction : undefined;
      let bundle: TrailBundle;
      let withoutModel: boolean;
      if (a.specialist === 'test-plan') {
        // The test-plan agent looks each fresh row up in the knowledge base (its allow-list), then drafts with its model.
        const toolbox = ctx.models?.available ? new Toolbox({ db, port, run, starter, engagement: e }, 'test-plan') : undefined;
        const draft = await draftTestPlansWithModel(e, { models: ctx.models, toolbox });
        ({ bundle } = await port.saveTestPlans(e.id, draft.plans, acting, { expectedVersion: e.version! }));
        withoutModel = draft.withoutModel;
      } else {
        ({ bundle } = await port.runModule(e.id, a.specialist, acting, { expectedVersion: e.version!, rows: a.rows, instruction, llm }));
        withoutModel = !!llm && bundle.qaActions.some((q) => q.gate === 'model-availability');
      }
      const used = ctx.models?.take();
      const rowBases = a.subjectKey === 'gaps' && a.rows ? Object.fromEntries(a.rows.map((id) => [id, rowBasis(e, id)])) : undefined;
      const record: DelegateRecord = {
        action: a, basis, sinceGateId, bundleId: bundle.id, ...(rowBases ? { rowBases } : {}), ...(withoutModel ? { withoutModel: true as const } : {}),
      };
      await db.transaction().execute(async (trx) => {
        await assertLease(trx, run.id, run.leaseOwner!);
        await appendStep(trx, run.id, {
          kind: 'delegate', agent: `specialist:${a.specialist}`, decision: record, model: used?.model ?? bundle.provider.model,
          tokensIn: used?.tokensIn ?? 0, tokensOut: used?.tokensOut ?? 0, costUsd: used?.costUsd ?? 0,
          durationMs: Date.now() - started, trailBundleId: bundle.id,
        });
      });
      return { next: 'continue' };
    }
    case 'request_qa': {
      const steps = await listSteps(db, run.id);
      // A challenge builds on the latest report of this same subject AND this same content, so its cap and carried issues apply.
      const hash = subjectInfo(e, a.subjectKey)?.hash;
      const previous = a.mode === 'challenge'
        ? [...steps].reverse().filter((st) => st.kind === 'qa').map((st) => st.decision as QaReport)
            .find((q) => q.subjectKey === a.subjectKey && q.subjectHash === hash) ?? null
        : null;
      // The model calls happen here, outside any transaction.
      const toolbox = ctx.models?.available ? new Toolbox({ db, port, run, starter, engagement: e }, 'qa') : undefined;
      const reviewed = await reviewWithAgent(e, a.subjectKey, a.mode, { models: ctx.models, toolbox, checks: ctx.checks, previous });
      const report = flagDraftWithoutModel(reviewed, steps);
      const used = ctx.models?.take();
      await db.transaction().execute(async (trx) => {
        await assertLease(trx, run.id, run.leaseOwner!);
        const sealed = await appendTrail(trx, event('agent:qa', 'qa', { subjectKey: a.subjectKey, mode: a.mode }, report));
        await appendStep(trx, run.id, {
          kind: 'qa', agent: 'qa', decision: report, model: used?.model ?? report.reviewer,
          tokensIn: used?.tokensIn ?? 0, tokensOut: used?.tokensOut ?? 0, costUsd: used?.costUsd ?? 0, trailBundleId: sealed.id,
        });
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
        // Lock order is engagement, then run, then gate. The gate is bound to the content read at the start of this
        // iteration, so it opens only if nobody has changed the engagement since.
        const loaded = await loadEngagement(trx, e.id, { forUpdate: true });
        if (!loaded) throw new AppError(404, `Engagement ${e.id} not found`);
        if (loaded.version !== e.version) {
          throw new AppError(409, `Engagement ${e.id} is at version ${loaded.version}, not ${e.version}; reload and try again`, 'VERSION_CONFLICT');
        }
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
