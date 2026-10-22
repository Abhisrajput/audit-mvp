import { z } from 'zod';
import { asData, DATA_RULES } from '../../engine/llm/prompt';
import { MalformedOutputError } from '../../engine/llm/provider';
import type { Engagement, JudgmentMemo, RcmRow, TestPlan } from '../../engine/types';
import { planMemo } from '../../judgment/memo';
import { acceptsSelection, recommendedTolerance, selectionFor, TOLERANCE_MAX } from '../../judgment/sampling';
import { ModelUnavailableError, type AgentModels } from '../llm/models';
import { rcmRowHash } from '../subjects';
import type { KnowledgeHit } from '../tools/knowledge';
import type { Toolbox } from '../tools/toolbox';

/**
 * Drafts a test plan for each RCM row (spec §3.1) from what the RCM already says: the control objective is the
 * attribute tested, and the RCM's sample size, evidence and procedure carry over. A plan whose row has not changed
 * is kept exactly as it is, including a person's edits. A person's reason for not testing a row is carried over even
 * when the row changed: the agent never sets or clears it. Plans for rows that are gone are dropped.
 */
export function draftTestPlans(e: Engagement): Record<string, TestPlan> {
  const plans: Record<string, TestPlan> = {};
  for (const row of e.rcm) {
    const existing = e.testPlans[row.id];
    const rowHash = rcmRowHash(row);
    if (existing?.rowHash === rowHash) {
      plans[row.id] = existing;
      continue;
    }
    const draft: TestPlan = {
      rowId: row.id,
      rowHash,
      attribute: row.objective,
      population: `Every performance of "${row.control}" (${row.frequency.toLowerCase()}) from ${e.periodFrom} to ${e.periodTo}`,
      sampleSize: row.sampleSize,
      selectionMethod: selectionFor(row, e.context).method,
      recommendedToleranceRate: recommendedTolerance(row, row.assessedRisk ?? row.riskRating),
      evidenceToRequest: [...row.evidenceExpected],
      procedure: row.testOfEffectiveness.join('\n'),
    };
    if (existing?.notTestedJustification) {
      draft.notTestedJustification = existing.notTestedJustification;
      if (existing.editedBy) draft.editedBy = existing.editedBy;
      if (existing.editedAt) draft.editedAt = existing.editedAt;
    }
    plans[row.id] = draft;
  }
  return plans;
}

// ---------- Drafting with the model (plan 2B) ----------

/** Rows whose plan is written afresh: no plan yet, or its RCM row changed. Every other plan is kept exactly as it is. */
export const rowsToDraft = (e: Engagement): RcmRow[] => e.rcm.filter((r) => e.testPlans[r.id]?.rowHash !== rcmRowHash(r));

export const PLAN_SYSTEM = `You draft test plans for internal-audit field work. For each RCM row given, write the attribute to test, the population to sample from (with its period and source), the selection method, the sample size, the evidence to request, and the procedure, as concrete steps another auditor could repeat. Use only the facts given. You may suggest in the procedure that a row need not be tested, and why; only an auditor decides that.
${DATA_RULES}`;

export const ModelPlansSchema = z.object({
  plans: z.array(z.object({
    rowId: z.string(),
    attribute: z.string(),
    population: z.string(),
    sampleSize: z.number().int(),
    selectionMethod: z.enum(['random', 'all', 'judgemental']),
    recommendedToleranceRate: z.number().min(0).max(TOLERANCE_MAX).optional(),
    evidenceToRequest: z.array(z.string()),
    procedure: z.string(),
  })),
});
export type ModelPlan = z.infer<typeof ModelPlansSchema>['plans'][number];

/** Everything from the engagement, the RCM and the knowledge base reaches the model only inside data blocks. */
export function planPrompt(e: Engagement, rows: RcmRow[], base: Record<string, TestPlan>, knowledge: Record<string, KnowledgeHit[]>): string {
  return [
    `Audit period ${e.periodFrom} to ${e.periodTo}. Draft a plan for each of these ${rows.length} RCM row(s). Each comes with a rule-based starting point; keep every sample size at or above the RCM's. You may set recommendedToleranceRate, but only a lower value than the starting point is accepted; a selection method is accepted only if it is the starting point or changes random to judgemental.`,
    asData('engagement', { entity: e.entity, site: e.site, scopeStatement: e.scopeStatement }),
    ...rows.flatMap((r) => {
      const s = base[r.id];
      const hits = knowledge[r.id] ?? [];
      return [
        asData(`rcm-row:${r.id}`, {
          row: { id: r.id, control: r.control, objective: r.objective, risk: r.risk, frequency: r.frequency, nature: r.nature, assessedRisk: r.assessedRisk ?? r.riskRating, samplingRationale: r.samplingRationale, recommendedToleranceRate: base[r.id].recommendedToleranceRate, sampleSize: r.sampleSize, testOfEffectiveness: r.testOfEffectiveness, evidenceExpected: r.evidenceExpected },
          startingPoint: { attribute: s.attribute, population: s.population, sampleSize: s.sampleSize, selectionMethod: s.selectionMethod, evidenceToRequest: s.evidenceToRequest, procedure: s.procedure },
        }),
        ...(hits.length ? [asData(`knowledge:${r.id}`, hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet, source: h.source })))] : []),
      ];
    }),
  ].join('\n');
}

/**
 * The model's plans, taken only for the rows it was given (each once), inside the rails. The RCM's sample size is a
 * floor; the row hash is set here, and a person's reason not to test a row rides along on the starting plan, so the
 * model can neither set nor clear it.
 */
export function applyModelPlans(base: Record<string, TestPlan>, rows: RcmRow[], drafted: ModelPlan[]): { plans: Record<string, TestPlan>; refusals: string[]; changes: string[] } {
  const out = { ...base };
  const refusals: string[] = [];
  const changes: string[] = [];
  const open = new Map(rows.map((r) => [r.id, r]));
  for (const d of drafted) {
    const row = open.get(d.rowId);
    if (!row) continue;
    open.delete(d.rowId);
    const start = base[row.id];
    let selectionMethod = start.selectionMethod;
    if (acceptsSelection(start.selectionMethod, d.selectionMethod)) {
      if (d.selectionMethod !== start.selectionMethod) {
        selectionMethod = d.selectionMethod;
        changes.push(`${row.id}: the model changed the selection from ${start.selectionMethod} to ${d.selectionMethod}`);
      }
    } else {
      refusals.push(`${row.id}: the model proposed ${d.selectionMethod} selection; the rule's ${start.selectionMethod} selection was kept`);
    }
    let tolerance = start.recommendedToleranceRate;
    if (d.recommendedToleranceRate !== undefined && tolerance !== undefined) {
      if (d.recommendedToleranceRate < tolerance) {
        changes.push(`${row.id}: the model lowered the recommended tolerance from ${tolerance} to ${d.recommendedToleranceRate}`);
        tolerance = d.recommendedToleranceRate;
      } else if (d.recommendedToleranceRate > tolerance) {
        refusals.push(`${row.id}: the model proposed a recommended tolerance of ${d.recommendedToleranceRate}; the rule's ${tolerance} was kept`);
      }
    }
    const evidence = d.evidenceToRequest.map((x) => x.trim()).filter(Boolean).slice(0, 20);
    out[row.id] = {
      ...start,
      attribute: d.attribute.trim() || start.attribute,
      population: d.population.trim() || start.population,
      sampleSize: Math.max(d.sampleSize, row.sampleSize),
      selectionMethod,
      ...(tolerance === undefined ? {} : { recommendedToleranceRate: tolerance }),
      evidenceToRequest: evidence.length ? evidence : start.evidenceToRequest,
      procedure: d.procedure.trim() || start.procedure,
      rowHash: rcmRowHash(row),
    };
  }
  return { plans: out, refusals, changes };
}

export interface PlanDraftOptions {
  models?: AgentModels;
  /** The test-plan agent's tools: one knowledge search per row being drafted. */
  toolbox?: Toolbox;
}

export interface PlanDraft {
  plans: Record<string, TestPlan>;
  /** What the plans decided, for the reviewer (spec §5.3). */
  memo: JudgmentMemo;
  /** A model was configured but failed, so the plans are the rule-based drafts (spec §6.3). */
  withoutModel: boolean;
}

/** Test plans for every RCM row: the rule-based drafts, with the rows that need a fresh plan tailored by the model. */
export async function draftTestPlansWithModel(e: Engagement, o: PlanDraftOptions = {}): Promise<PlanDraft> {
  const base = draftTestPlans(e);
  const rows = rowsToDraft(e);
  const memoOf = (plans: Record<string, TestPlan>, refusals: string[] = [], modelChanges: string[] = []) =>
    planMemo({ plans, rows: e.rcm, context: e.context, refusals, modelChanges, producedAt: new Date().toISOString() });
  if (!o.models?.available || !rows.length) return { plans: base, memo: memoOf(base), withoutModel: false };
  try {
    const knowledge: Record<string, KnowledgeHit[]> = {};
    if (o.toolbox) {
      for (const r of rows) knowledge[r.id] = (await o.toolbox.call('search_knowledge', { query: `${r.control} ${r.objective}`.slice(0, 200), limit: 3 })) as KnowledgeHit[];
    }
    const { output } = await o.models.generate('test-plan', { system: PLAN_SYSTEM, user: planPrompt(e, rows, base, knowledge), schema: ModelPlansSchema });
    const applied = applyModelPlans(base, rows, output.plans);
    return { plans: applied.plans, memo: memoOf(applied.plans, applied.refusals, applied.changes), withoutModel: false };
  } catch (err) {
    // A refused budget or a lost lease ends the iteration; a model that is down or answers badly leaves the rule-based drafts.
    if (err instanceof ModelUnavailableError || err instanceof MalformedOutputError) return { plans: base, memo: memoOf(base), withoutModel: true };
    throw err;
  }
}
