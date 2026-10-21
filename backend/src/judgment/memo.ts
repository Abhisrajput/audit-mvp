// The judgment memo (spec §3.4): what the engine decided, why, and which standard
// it leans on, written so a reviewer can sign against it. Pure: no I/O.

import { canonicalJson } from '../engine/trail';
import type { Coverage, EngagementContext, Finding, JudgmentCall, JudgmentMemo, RcmRow, RiskRating, ScopeItem, TestPlan, TestResult } from '../engine/types';
import { factorsFor } from './context';
import { areaRisk, RANK } from './risk-assessment';
import { IIA } from './standards';

/** A judgment call; the source is 'rules' unless the caller says otherwise. */
export function call(partial: Omit<JudgmentCall, 'source'> & { source?: JudgmentCall['source'] }): JudgmentCall {
  return { ...partial, source: partial.source ?? 'rules' };
}

/** The scope memo: one call per area whose assessed risk differs from the library (and a "no change" summary when none), one call for the coverage (the model's when coverageByModel), one per context inclusion; forTheReviewer lists unverified model claims and any factor naming an unknown area. */
export function scopeMemo(input: { items: ScopeItem[]; coverage: Coverage; context: EngagementContext | null; unknownAreas: string[]; modelNotes: string[]; producedAt: string; modelRaises?: { processArea: string; rationale: string }[]; contextIncluded?: string[]; coverageByModel?: boolean }): JudgmentMemo {
  const { items, coverage } = input;
  const calls: JudgmentCall[] = [];

  // Items grouped by area, in order of first appearance.
  const areas = new Map<string, ScopeItem[]>();
  for (const item of items) areas.set(item.processArea, [...(areas.get(item.processArea) ?? []), item]);

  let changed = 0;
  for (const [area, group] of areas) {
    const library = group.reduce<RiskRating>((top, i) => (RANK[i.inherentRisk] > RANK[top] ? i.inherentRisk : top), 'Low');
    const assessed = areaRisk(group);
    if (assessed === library) continue;
    changed += 1;
    const factors = factorsFor(input.context, area).map((f) => `${f.description} (${f.processAreas.length === 0 ? 'the whole entity' : f.processAreas.join(', ')})`);
    calls.push(call({
      question: `Risk of the ${area} area`,
      decision: `${assessed} (library: ${library})`,
      rationale: `The engagement context raises the risk of the ${area} area above the library rating.${factors.length ? ` Factors: ${factors.join('; ')}.` : ''}`,
      basis: [...new Set(group.flatMap((i) => i.riskFactors))],
      standard: [IIA.riskAssessment],
    }));
  }
  // Areas the model raised: credit the model on the area's call. An area with no call (its risk did not change) gets nothing.
  for (const raise of input.modelRaises ?? []) {
    const target = calls.find((c) => c.question === `Risk of the ${raise.processArea} area`);
    if (!target) continue;
    target.source = 'model';
    target.rationale = `${target.rationale} Model: ${raise.rationale}`;
  }
  if (changed === 0) {
    calls.push(call({
      question: 'Risk of each process area',
      decision: 'The library ratings stand.',
      rationale: 'The engagement context does not change the risk of any process area.',
      basis: [],
      standard: [IIA.riskAssessment],
    }));
  }

  calls.push(call({
    question: 'What is in scope',
    decision: coverage.statement,
    rationale: coverage.excluded.length === 0 ? 'Every process area has at least one control in scope.' : 'These process areas have no control in scope.',
    basis: coverage.excluded.map((e) => `${e.processArea}: ${e.reason}`),
    standard: [IIA.scope],
    // The model's coverage statement or an exclusion reason it gave was accepted.
    source: input.coverageByModel ? 'model' : 'rules',
  }));

  // Inclusion calls come from the ids the rules chose, never from the rationale text, which a model can write.
  const chosen = new Set(input.contextIncluded ?? []);
  for (const item of items) {
    if (!chosen.has(item.controlId) || !item.included) continue;
    const reason = factorsFor(input.context, item.processArea)[0]?.description ?? '';
    calls.push(call({
      question: `Why ${item.controlId} is in scope`,
      decision: `Included, although its relevance is below the threshold`,
      rationale: `included: ${reason}`,
      basis: [reason],
      standard: [IIA.riskAssessment, IIA.scope],
    }));
  }

  const forTheReviewer = [
    ...input.unknownAreas.map((area) => `Factor names an area with no control in the chosen packs: ${area}`),
    ...input.modelNotes,
  ];
  if (forTheReviewer.length === 0) forTheReviewer.push('Nothing to verify beyond the calls above.');

  return { subjectKey: 'scope', calls, forTheReviewer, producedAt: input.producedAt };
}

/** The line the memo carries once a person has edited the scope it describes. */
export const EDITED_BY_HAND = 'The scope was edited by hand after this memo; the coverage shown reflects the edited scope.';

/** The memo after a hand edit of the scope: its calls stay the agent's, and the reviewer is told once. */
export function markEditedByHand(memo: JudgmentMemo): JudgmentMemo {
  return { ...memo, forTheReviewer: [...memo.forTheReviewer.filter((line) => line !== EDITED_BY_HAND), EDITED_BY_HAND] };
}

/** The line the memo carries once a person has edited what it describes, naming who and what. Replaces that person's earlier line; other people's stay. */
export function markEditedByPerson(memo: JudgmentMemo, actor: string, changes: string[]): JudgmentMemo {
  const mine = `Edited by ${actor}:`;
  return { ...memo, forTheReviewer: [...memo.forTheReviewer.filter((line) => !line.startsWith(mine)), `${mine} ${changes.join('; ')}.`] };
}

/** Whether two memos say the same thing: producedAt and the hand-edit line do not count. Absent on both sides is the same; absent on one is not. */
export function sameMemo(a: JudgmentMemo | undefined, b: JudgmentMemo | undefined): boolean {
  if (!a || !b) return !a && !b;
  const bare = (m: JudgmentMemo) => canonicalJson({ ...m, producedAt: '', forTheReviewer: m.forTheReviewer.filter((line) => line !== EDITED_BY_HAND) });
  return bare(a) === bare(b);
}

const pct = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

/** The RCM memo: one call per row whose assessed risk differs from its library rating (naming the sample size), and a summary. */
export function rcmMemo(input: { rows: RcmRow[]; scope: ScopeItem[]; context: EngagementContext | null; producedAt: string }): JudgmentMemo {
  const calls: JudgmentCall[] = [];
  for (const r of input.rows) {
    if (!r.assessedRisk || r.assessedRisk === r.riskRating) continue;
    calls.push(call({
      question: `Sample size for ${r.id}`,
      decision: `${r.sampleSize} items at ${r.assessedRisk} assessed risk (library: ${r.riskRating})`,
      rationale: r.samplingRationale ?? `The assessed risk of ${r.id} differs from the library rating, so the sample follows the assessed risk.`,
      basis: [r.control, ...factorsFor(input.context, r.processArea).map((f) => f.description)],
      standard: [IIA.resources],
    }));
  }
  const inScope = input.scope.filter((i) => i.included).length;
  calls.push(call({
    question: 'Resources for the testing',
    decision: `${input.rows.length} controls to test${input.scope.length ? ` from ${inScope} in scope` : ''}`,
    rationale: calls.length === 0 ? 'Every control is sampled at the library rating.' : `${calls.length} control(s) are sampled above or below the library rating.`,
    basis: [],
    standard: [IIA.resources],
  }));
  return { subjectKey: 'rcm', calls, forTheReviewer: ['Nothing to verify beyond the calls above.'], producedAt: input.producedAt };
}

/** The test-plan memo: one call per plan whose selection is not random, one per non-zero recommended tolerance; refusals and model changes go to the reviewer. */
export function planMemo(input: { plans: Record<string, TestPlan>; rows: RcmRow[]; context: EngagementContext | null; refusals: string[]; modelChanges: string[]; producedAt: string }): JudgmentMemo {
  const calls: JudgmentCall[] = [];
  const rowOf = new Map(input.rows.map((r) => [r.id, r]));
  for (const p of Object.values(input.plans)) {
    const r = rowOf.get(p.rowId);
    if (p.selectionMethod !== 'random') {
      calls.push(call({
        question: `How ${p.rowId} is selected`,
        decision: `${p.selectionMethod} selection`,
        rationale: `Random selection is not used for ${p.rowId}: ${p.selectionMethod} selection fits the control better.`,
        basis: r ? [r.control, `Frequency: ${r.frequency}`] : [],
        standard: [IIA.workProgram],
        source: input.modelChanges.some((m) => m.startsWith(p.rowId)) ? 'model' : 'rules',
      }));
    }
    if (p.recommendedToleranceRate) {
      calls.push(call({
        question: `Tolerance to consider for ${p.rowId}`,
        decision: `${pct(p.recommendedToleranceRate)} of the sample may fail`,
        rationale: 'A recommendation only; a person records the tolerance that applies.',
        basis: r?.assessedRisk ? [`Assessed risk: ${r.assessedRisk}`] : [],
        standard: [IIA.workProgram],
      }));
    }
  }
  if (calls.length === 0) {
    calls.push(call({ question: 'How the controls are tested', decision: 'Random selection, no tolerance recommended', rationale: 'No plan departs from the default.', basis: [], standard: [IIA.workProgram] }));
  }
  const forTheReviewer = [...input.refusals, ...input.modelChanges];
  if (forTheReviewer.length === 0) forTheReviewer.push('Nothing to verify beyond the calls above.');
  return { subjectKey: 'test_plans', calls, forTheReviewer, producedAt: input.producedAt };
}

/** The finding memo: the rating, the root cause and the recommendation, each credited to the model when it changed it. */
export function findingMemo(input: { finding: Pick<Finding, 'rowId' | 'likelihood' | 'impact' | 'rating' | 'rootCause' | 'recommendation'>; row: Pick<RcmRow, 'assessedRisk' | 'riskRating' | 'control'>; result: Pick<TestResult, 'conclusion' | 'exceptionRate' | 'severity'>; libraryRecommendation: string; modelMoves: string[]; producedAt: string }): JudgmentMemo {
  const { finding: f, row, result } = input;
  const moved = (what: string) => input.modelMoves.includes(what);
  const rootCause = f.rootCause;
  const calls = [
    call({
      question: 'Rating of the finding',
      decision: `${f.rating}${f.likelihood && f.impact ? ` (${f.likelihood} likelihood, ${f.impact} impact)` : ''}`,
      rationale: `${result.conclusion}${result.exceptionRate != null ? ` with an exception rate of ${pct(result.exceptionRate)}` : ''}${result.severity ? `, ${result.severity} severity` : ''}; assessed risk of the control ${row.assessedRisk ?? row.riskRating}.`,
      basis: [row.control],
      standard: [IIA.evaluation],
      source: moved('rating') ? 'model' : 'rules',
    }),
    call({
      question: 'Root cause',
      decision: rootCause ? `${rootCause.category}${rootCause.confirmed ? ' (confirmed)' : ' (not confirmed)'}` : 'Not determined',
      rationale: rootCause?.analysis ?? 'No root cause analysis was recorded.',
      basis: [row.control],
      standard: [IIA.analysis],
      source: moved('root cause') ? 'model' : 'rules',
    }),
    call({
      question: 'Recommendation',
      decision: f.recommendation,
      rationale: f.recommendation === input.libraryRecommendation ? 'The library recommendation stands.' : `Adapted from the library recommendation: ${input.libraryRecommendation}`,
      basis: [input.libraryRecommendation],
      standard: [IIA.recommendations],
      source: moved('recommendation') ? 'model' : 'rules',
    }),
  ];
  const forTheReviewer = rootCause && !rootCause.confirmed ? ['The root cause is a proposal; confirm it with the control owner.'] : ['Nothing to verify beyond the calls above.'];
  return { subjectKey: `finding:${f.rowId}`, calls, forTheReviewer, producedAt: input.producedAt };
}

/** Markdown for the gate panel: a heading per call, then "For the reviewer". */
export function renderMemo(memo: JudgmentMemo): string {
  const sections = memo.calls.map((c) => {
    const lines = [`## ${c.question}`, '', `**Decision:** ${c.decision}`, '', `**Why:** ${c.rationale}`];
    if (c.basis.length > 0) lines.push('', '**Basis:**', ...c.basis.map((b) => `- ${b}`));
    lines.push('', `**Standard:** ${c.standard.join(', ')}`, '', `_Source: ${c.source}_`);
    return lines.join('\n');
  });
  sections.push(['## For the reviewer', '', ...memo.forTheReviewer.map((line) => `- ${line}`)].join('\n'));
  return sections.join('\n\n') + '\n';
}
