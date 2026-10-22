import type { Engagement } from '../../engine/types';
import { IIA } from '../../judgment/standards';
import { rowOfKey } from '../subjects';

// The QA agent's rubrics (spec §5.5): the judgement criteria a model scores 0–4 for each workpaper type, and the
// adversarial criteria of a challenge pass. The computable criteria (coverage, completeness, citation validity) are
// the automatic checks in deterministic.ts, which run with or without a model.

export interface RubricCriterion {
  id: string;
  question: string;
  /** The IIA Standards clause id this criterion rests on. */
  standard?: string;
}

export type RubricKind = 'scope' | 'rcm' | 'test_plans' | 'finding' | 'report';

export const RUBRICS: Readonly<Record<RubricKind, readonly RubricCriterion[]>> = {
  scope: [
    { id: 'scope.risk-coverage', question: 'Do the controls in scope address the risks the scope statement names?', standard: IIA.riskAssessment },
    { id: 'scope.rationale', question: 'Is each in or out decision explained by its rationale?', standard: IIA.communication },
    { id: 'scope.proportionality', question: 'Is the scope proportionate: no material area left out, nothing irrelevant in?', standard: IIA.scope },
  ],
  rcm: [
    { id: 'rcm.risk-control-link', question: 'Does each control plausibly mitigate the risk it is paired with?' },
    { id: 'rcm.procedure-specificity', question: 'Are the test steps concrete enough for another auditor to repeat?' },
    { id: 'rcm.sample-appropriateness', question: "Do the sample sizes suit each control's frequency and risk?", standard: IIA.resources },
  ],
  test_plans: [
    { id: 'plans.attribute-clarity', question: 'Does each plan state one clear attribute to test?', standard: IIA.workProgram },
    { id: 'plans.population', question: 'Is each population defined by period and source, so a sample can be drawn from it?', standard: IIA.workProgram },
    { id: 'plans.evidence', question: 'Would the evidence requested show whether the attribute holds?', standard: IIA.workProgram },
  ],
  finding: [
    { id: 'finding.condition-evidence', question: 'Is the condition supported by the recorded test and its evidence references?', standard: IIA.gathering },
    { id: 'finding.criteria-citation', question: 'Do the criteria follow from the clauses cited?', standard: IIA.criteria },
    { id: 'finding.cause-effect', question: 'Are the cause and effect specific and consistent with the condition?', standard: IIA.analysis },
    { id: 'finding.recommendation', question: 'Is the recommendation actionable and aimed at the cause?', standard: IIA.recommendations },
    { id: 'finding.rating-basis', question: 'Do the likelihood, impact and rating follow from the result and the assessed risk?', standard: IIA.evaluation },
  ],
  report: [
    { id: 'report.accuracy', question: 'Does the report state the approved findings without changing their substance?' },
    { id: 'report.completeness', question: 'Does it cover the scope, the approach and every approved finding?' },
    { id: 'report.tone', question: 'Is it factual, with no speculation about intent?' },
    { id: 'report.opinion-basis', question: 'Does the overall opinion follow from the approved findings and the rule, and does its basis say why?', standard: IIA.conclusions },
  ],
};

export const CHALLENGE_CRITERIA: readonly RubricCriterion[] = [
  { id: 'challenge.unsupported-claims', question: 'Is every claim supported by the evidence, test results or clauses given?' },
  { id: 'challenge.missing-risks', question: 'Are significant risks or controls missing?' },
  { id: 'challenge.citation-support', question: 'Does each citation support the text that relies on it?' },
];

export const rubricKind = (subjectKey: string): RubricKind => (rowOfKey(subjectKey) ? 'finding' : (subjectKey as RubricKind));

/** 0–4 scores as 0–100. With no scores there is nothing to mark down. */
export function normalise(scores: readonly number[]): number {
  if (!scores.length) return 100;
  return Math.round((100 * scores.reduce((a, b) => a + b, 0)) / (4 * scores.length));
}

/** What a reviewer reads of a subject. It reaches a model only through asData. */
export function subjectContent(e: Engagement, subjectKey: string): unknown {
  const labels = (citations: { label: string }[]) => citations.map((c) => c.label);
  switch (subjectKey) {
    case 'scope':
      return {
        scopeStatement: e.scopeStatement,
        items: e.scope.map((s) => ({ controlId: s.controlId, risk: s.risk, inherentRisk: s.inherentRisk, assessedRisk: s.assessedRisk, riskFactors: s.riskFactors, included: s.included, rationale: s.rationale, citations: labels(s.citations) })),
        coverage: e.coverage,
      };
    case 'rcm':
      return e.rcm.map((r) => ({
        id: r.id, control: r.control, risk: r.risk, riskRating: r.riskRating, objective: r.objective, frequency: r.frequency, sampleSize: r.sampleSize,
        testOfDesign: r.testOfDesign, testOfEffectiveness: r.testOfEffectiveness, evidenceExpected: r.evidenceExpected, citations: labels(r.citations),
      }));
    case 'test_plans':
      return e.rcm.map((r) => ({ row: { id: r.id, control: r.control, frequency: r.frequency, sampleSize: r.sampleSize }, plan: e.testPlans[r.id] ?? null, tolerance: e.tolerances[r.controlId] ?? null, recommendedToleranceRate: e.testPlans[r.id]?.recommendedToleranceRate ?? null }));
    case 'report':
      return { markdown: e.report?.markdown ?? null, opinion: e.report?.opinion ?? null, memo: e.memos?.report ?? null };
  }
  const rowId = rowOfKey(subjectKey);
  const f = rowId ? e.findings.find((x) => x.rowId === rowId) : undefined;
  if (!rowId || !f) return null;
  const { title, rating, likelihood, impact, rootCause, condition, criteria, cause, effect, recommendation, evidenceRefs } = f;
  return {
    finding: { title, rating, likelihood: likelihood ?? null, impact: impact ?? null, rootCause: rootCause ?? null, severity: e.testResults[rowId]?.severity ?? null, condition, criteria, cause, effect, recommendation, evidenceRefs, citations: labels(f.citations) },
    test: { input: e.testInputs[rowId] ?? null, result: e.testResults[rowId] ?? null },
  };
}
