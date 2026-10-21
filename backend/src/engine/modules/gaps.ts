import crypto from 'node:crypto';
import { z } from 'zod';
import type { AuditModule } from '../module';
import { findingCitationGate, toCitation } from '../qa';
import { causeSupported, IMPACTS, impactOf, LIKELIHOODS, likelihoodOf, oneStepWorse, PLACEHOLDER_CAUSE, ratingOf } from '../../judgment/finding';
import { findingMemo } from '../../judgment/memo';
import type { Citation, Finding, Impact, Likelihood, RcmRow, TestInput, TestResult } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

/** Deterministic finding draft using the 5 C's (condition, criteria, cause, effect, recommendation). */
export function draftFinding(ctxRegistry: { clauses: Map<string, { regulation: string; ref: string; summary: string }> }, row: RcmRow, input: TestInput, result: TestResult, recommendation: string): Omit<Finding, 'id' | 'bundleId'> {
  const sample = input.sampleTested ? ` [Sample: ${input.exceptions} exception(s) in ${input.sampleTested} items tested.]` : '';
  const criteria = row.citations
    .map((c) => {
      const clause = ctxRegistry.clauses.get(c.clauseId);
      return `${c.regulation} ${c.ref}: ${clause?.summary ?? ''}`.trim();
    })
    .join(' ');
  const likelihood = likelihoodOf(result);
  const impact = impactOf(row.assessedRisk ?? row.riskRating);
  const rating = ratingOf(likelihood, impact);
  const rootCause = { category: 'unknown' as const, analysis: PLACEHOLDER_CAUSE, confirmed: false };
  const draft: Omit<Finding, 'id' | 'bundleId'> = {
    rowId: row.id,
    controlId: row.controlId,
    title: result.conclusion === 'Design deficient' ? `${row.control}: control design gap` : `${row.control}: exceptions in operation`,
    rating,
    likelihood,
    impact,
    rootCause,
    condition: `${input.observation.trim()}${sample}`,
    criteria: `${criteria} Control objective: ${row.objective}`,
    cause: PLACEHOLDER_CAUSE,
    effect: row.risk,
    recommendation,
    citations: row.citations,
    evidenceRefs: [...input.evidenceRefs],
    status: 'draft',
    blockedReasons: [],
    signOffs: [],
  };
  return { ...draft, memo: findingMemo({ finding: draft, row, result, libraryRecommendation: recommendation, modelMoves: [], producedAt: new Date().toISOString() }) };
}

const ModelFinding = z.object({
  findings: z.array(
    z.object({
      rowId: z.string(),
      title: z.string(),
      likelihood: z.enum(LIKELIHOODS as [Likelihood, ...Likelihood[]]).optional(),
      impact: z.enum(IMPACTS as [Impact, ...Impact[]]).optional(),
      rootCause: z.object({ category: z.enum(['people', 'process', 'system', 'governance', 'unknown']), analysis: z.string(), confirmed: z.boolean() }),
      condition: z.string(),
      criteria: z.string(),
      cause: z.string(),
      effect: z.string(),
      recommendation: z.string(),
      clauseIds: z.array(z.string()),
    }),
  ),
});

/** Gap Writer: drafts findings for failed controls with triple citation, then gates them. */
export const gapsModule: AuditModule<Finding[]> = {
  id: 'gaps',
  name: 'Gap Writer',
  version: '0.1.0',
  description: 'Drafts findings (condition, criteria, cause, effect, recommendation) with regulation + control + evidence citations.',
  precondition: (e) => (Object.keys(e.testResults).length ? null : 'Run Testing first'),

  async run(ctx) {
    const e = ctx.engagement;
    const failed = e.rcm.filter((r) => ['Ineffective', 'Design deficient'].includes(e.testResults[r.id]?.conclusion));
    const locked = new Set(e.findings.filter((f) => f.status === 'approved').map((f) => f.rowId));
    const todo = failed.filter((r) => !locked.has(r.id));
    ctx.step('select', `${failed.length} failed controls; ${locked.size} already approved and locked; drafting ${todo.length}`);

    // Grounding set per row: the control's own clauses plus top hits for the observation.
    const allowed = new Map<string, Set<string>>();
    for (const r of todo) {
      const hits = ctx.retrieveClauses(`${r.control} ${e.testInputs[r.id].observation}`, 3);
      allowed.set(r.id, new Set([...r.citations.map((c) => c.clauseId), ...hits.map((h) => h.clauseId)]));
    }

    const drafts = new Map<string, Omit<Finding, 'id' | 'bundleId'>>();
    for (const r of todo) {
      const control = ctx.registry.controls.get(r.controlId)!;
      drafts.set(r.id, draftFinding(ctx.registry, r, e.testInputs[r.id], e.testResults[r.id], control.recommendation));
    }

    const modelOut = await askModel(
      ctx,
      SYSTEM_PREAMBLE,
      `Draft one audit finding per failed control. Use the 5 C's. "criteria" must quote the clause reference (e.g. "§211.192") for every clause you cite.\n` +
        `Do not state a root cause as fact unless the record supports it; otherwise say it is to be confirmed.\n` +
        `The rating is computed from likelihood and impact, never taken from you. Each row gives the rule's likelihood, impact and severity. You may name a likelihood or an impact exactly one step worse than the rule's value when the record supports it (rare, possible, likely; minor, moderate, major); any other value is refused. Omit them to keep the rule's value.\n` +
        `Give a root cause: a category (people, process, system, governance or unknown), your analysis in words the record uses, and confirmed true only when the record supports it. Then write a recommendation tailored to that cause category and the engagement context, not a copy of the library text.\n\n` +
        (e.context ? `Engagement context:\n${asData('engagement-context', { background: e.context.background, factors: e.context.factors })}\n\n` : '') +
        asData(
          'workpaper:failed-controls',
          todo.map((r) => ({
            rowId: r.id,
            control: r.control,
            objective: r.objective,
            risk: r.risk,
            inherentRisk: r.riskRating,
            assessedRisk: r.assessedRisk ?? r.riskRating,
            rule: { likelihood: drafts.get(r.id)!.likelihood, impact: drafts.get(r.id)!.impact, rating: drafts.get(r.id)!.rating, severity: e.testResults[r.id].severity },
            libraryRecommendation: ctx.registry.controls.get(r.controlId)!.recommendation,
            record: e.testInputs[r.id],
            conclusion: e.testResults[r.id],
            allowedClauses: [...allowed.get(r.id)!].map((id) => {
              const c = ctx.registry.clauses.get(id)!;
              return { clauseId: id, regulation: c.regulation, ref: c.ref, summary: c.summary };
            }),
          })),
        ),
      ModelFinding,
    );
    if (modelOut) {
      for (const m of modelOut.findings) {
        const d = drafts.get(m.rowId);
        if (!d) continue;
        const row = todo.find((r) => r.id === m.rowId)!;
        const refuse = (detail: string) => ctx.gate({ gate: 'judgment-bounds', outcome: 'fail', target: m.rowId, detail, action: 'blocked' });
        const modelMoves: string[] = [];
        let likelihood = d.likelihood!;
        let impact = d.impact!;
        if (m.likelihood && m.likelihood !== likelihood) {
          if (oneStepWorse(LIKELIHOODS, likelihood, m.likelihood)) likelihood = m.likelihood;
          else refuse(`Model proposed likelihood ${m.likelihood} where the rule gives ${likelihood}; only a value exactly one step worse is accepted, so the rule value stands`);
        }
        if (m.impact && m.impact !== impact) {
          if (oneStepWorse(IMPACTS, impact, m.impact)) impact = m.impact;
          else refuse(`Model proposed impact ${m.impact} where the rule gives ${impact}; only a value exactly one step worse is accepted, so the rule value stands`);
        }
        const rating = ratingOf(likelihood, impact);
        if (likelihood !== d.likelihood || impact !== d.impact) modelMoves.push('rating');
        let { confirmed } = m.rootCause;
        if (confirmed && !causeSupported(e.testInputs[m.rowId].observation, m.rootCause.analysis)) {
          confirmed = false;
          refuse('Model confirmed a root cause that shares no specific word with the recorded observation, so it stays unconfirmed');
        }
        const rootCause = { category: m.rootCause.category, analysis: m.rootCause.analysis, confirmed };
        modelMoves.push('root cause');
        const library = ctx.registry.controls.get(row.controlId)!.recommendation;
        if (m.recommendation !== library) modelMoves.push('recommendation');
        const next = {
          ...d,
          title: m.title,
          rating,
          likelihood,
          impact,
          rootCause,
          condition: m.condition,
          criteria: m.criteria,
          cause: m.cause,
          effect: m.effect,
          recommendation: m.recommendation,
          citations: m.clauseIds.map((id) => toCitation(ctx.registry, id) ?? { clauseId: id, regulation: '?', ref: '?', label: id }) as Citation[],
        };
        drafts.set(m.rowId, {
          ...next,
          memo: findingMemo({ finding: next, row, result: e.testResults[m.rowId], libraryRecommendation: library, modelMoves, producedAt: new Date().toISOString() }),
        });
      }
    }

    const out: Finding[] = e.findings.filter((f) => locked.has(f.rowId));
    for (const r of todo) {
      const finding: Finding = { ...drafts.get(r.id)!, id: `F-${r.id}-${crypto.randomBytes(2).toString('hex')}`, bundleId: '' };
      const gated = findingCitationGate(ctx.registry, finding, allowed.get(r.id)!, ctx.policy);
      ctx.gate(...gated.actions);
      out.push(gated.finding);
    }
    return out;
  },

  apply(e, findings, bundleId) {
    e.findings = findings.map((f) => (f.bundleId ? f : { ...f, bundleId }));
    e.stage = 'findings';
  },
};
