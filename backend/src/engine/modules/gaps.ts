import crypto from 'node:crypto';
import { z } from 'zod';
import type { AuditModule } from '../module';
import { findingCitationGate, toCitation } from '../qa';
import type { Citation, Finding, RcmRow, RiskRating, TestInput, TestResult } from '../types';
import { asData } from '../llm/prompt';
import { askModel, SYSTEM_PREAMBLE } from './llm-step';

function rate(row: RcmRow, result: TestResult): RiskRating {
  if (result.conclusion === 'Design deficient') return row.riskRating;
  const r = result.exceptionRate ?? 0;
  if (row.riskRating === 'Medium' && r >= 0.2) return 'High';
  if (row.riskRating === 'High' && r > 0 && r < 0.05) return 'Medium';
  return row.riskRating;
}

/** Deterministic finding draft using the 5 C's (condition, criteria, cause, effect, recommendation). */
export function draftFinding(ctxRegistry: { clauses: Map<string, { regulation: string; ref: string; summary: string }> }, row: RcmRow, input: TestInput, result: TestResult, recommendation: string): Omit<Finding, 'id' | 'bundleId'> {
  const sample = input.sampleTested ? ` [Sample: ${input.exceptions} exception(s) in ${input.sampleTested} items tested.]` : '';
  const criteria = row.citations
    .map((c) => {
      const clause = ctxRegistry.clauses.get(c.clauseId);
      return `${c.regulation} ${c.ref}: ${clause?.summary ?? ''}`.trim();
    })
    .join(' ');
  return {
    rowId: row.id,
    controlId: row.controlId,
    title: result.conclusion === 'Design deficient' ? `${row.control}: control design gap` : `${row.control}: exceptions in operation`,
    rating: rate(row, result),
    condition: `${input.observation.trim()}${sample}`,
    criteria: `${criteria} Control objective: ${row.objective}`,
    cause: 'Root cause to be confirmed with the process owner at the exit meeting.',
    effect: row.risk,
    recommendation,
    citations: row.citations,
    evidenceRefs: [...input.evidenceRefs],
    status: 'draft',
    blockedReasons: [],
    signOffs: [],
  };
}

const ModelFinding = z.object({
  findings: z.array(
    z.object({
      rowId: z.string(),
      title: z.string(),
      rating: z.enum(['High', 'Medium', 'Low']),
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
        `Do not state a root cause as fact unless the record supports it; otherwise say it is to be confirmed.\n\n` +
        asData(
          'workpaper:failed-controls',
          todo.map((r) => ({
            rowId: r.id,
            control: r.control,
            objective: r.objective,
            risk: r.risk,
            inherentRisk: r.riskRating,
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
        drafts.set(m.rowId, {
          ...d,
          title: m.title,
          rating: m.rating,
          condition: m.condition,
          criteria: m.criteria,
          cause: m.cause,
          effect: m.effect,
          recommendation: m.recommendation,
          citations: m.clauseIds.map((id) => toCitation(ctx.registry, id) ?? { clauseId: id, regulation: '?', ref: '?', label: id }) as Citation[],
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
