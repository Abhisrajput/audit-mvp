// The judgment memo (spec §3.4): what the engine decided, why, and which standard
// it leans on, written so a reviewer can sign against it. Pure: no I/O.

import type { Coverage, EngagementContext, JudgmentCall, JudgmentMemo, RiskRating, ScopeItem } from '../engine/types';
import { areaRisk } from './risk-assessment';
import { IIA } from './standards';

const RANK: Record<RiskRating, number> = { Low: 0, Medium: 1, High: 2 };

/** A judgment call; the source is 'rules' unless the caller says otherwise. */
export function call(partial: Omit<JudgmentCall, 'source'> & { source?: JudgmentCall['source'] }): JudgmentCall {
  return { ...partial, source: partial.source ?? 'rules' };
}

/** The scope memo: one call per area whose assessed risk differs from the library (and a "no change" summary when none), one call for the coverage, one per context inclusion; forTheReviewer lists unverified model claims and any factor naming an unknown area. */
export function scopeMemo(input: { items: ScopeItem[]; coverage: Coverage; context: EngagementContext | null; unknownAreas: string[]; modelNotes: string[]; producedAt: string }): JudgmentMemo {
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
    calls.push(call({
      question: `Risk of the ${area} area`,
      decision: `${assessed} (library: ${library})`,
      rationale: `The engagement context raises the risk of the ${area} area above the library rating.`,
      basis: [...new Set(group.flatMap((i) => i.riskFactors))],
      standard: [IIA.riskAssessment],
    }));
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
  }));

  for (const item of items) {
    if (!item.rationale?.startsWith('included: ')) continue;
    const reason = item.rationale.slice('included: '.length);
    calls.push(call({
      question: `Why ${item.controlId} is in scope`,
      decision: `Included, although its relevance is below the threshold`,
      rationale: item.rationale,
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
