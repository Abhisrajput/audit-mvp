// Scope coverage rules (spec §5.2): which controls the rules include, which areas end
// up with nothing, and the sentence that says so. Pure: no I/O, no model calls.

import type { Coverage, EngagementContext, RiskRating } from '../engine/types';
import { factorsFor } from './context';
import { isTouched } from './risk-assessment';

/** Today's thresholds: High-rated controls need less relevance than the rest. */
export const INCLUSION_THRESHOLD = { High: 0.25, other: 0.30 } as const;

export const REASON = { threshold: 'below relevance threshold', statement: 'excluded by the scope statement' } as const;

/** The rule keys on the assessed risk, so context can pull a control in. */
export function includedByRule(assessedRisk: RiskRating, relevance: number): boolean {
  return relevance >= (assessedRisk === 'High' ? INCLUSION_THRESHOLD.High : INCLUSION_THRESHOLD.other);
}

/** A candidate as the scope module sees it before inclusion is decided. */
export interface Candidate { controlId: string; processArea: string; inherentRisk: RiskRating; assessedRisk: RiskRating; relevance: number }

const RANK: Record<RiskRating, number> = { Low: 0, Medium: 1, High: 2 };

/** Candidates grouped by area, areas in order of first appearance. */
function byArea(candidates: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.processArea);
    if (group) group.push(candidate);
    else groups.set(candidate.processArea, [candidate]);
  }
  return groups;
}

/** §5.2: controls to include because their area is touched and has nothing above threshold. Keyed by controlId → the factor description used in the rationale. */
export function contextInclusions(candidates: Candidate[], context: EngagementContext | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const [area, group] of byArea(candidates)) {
    if (!isTouched(context, area)) continue;
    if (group.some((c) => includedByRule(c.assessedRisk, c.relevance))) continue;
    // Best first: most relevant, then the higher library rating, then the lower id.
    const best = [...group].sort(
      (a, b) => b.relevance - a.relevance || RANK[b.inherentRisk] - RANK[a.inherentRisk] || (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0),
    )[0];
    result.set(best.controlId, factorsFor(context, area)[0].description);
  }
  return result;
}

/** True when the scope statement speaks of leaving the area out, close to where it names it. */
function statementExcludes(scopeStatement: string, area: string): boolean {
  const name = area.trim();
  if (!name) return false;
  const text = scopeStatement.toLowerCase();
  const negation = /\bnot\b|\bexclud(?:e|ing)\b|\bout of scope\b/;
  // The area is a whole word or phrase, so "IT" does not match inside "within".
  const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
  for (const m of text.matchAll(mention)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (negation.test(before) || negation.test(after)) return true;
  }
  return false;
}

/** Every area of the candidates with no included control, with its reason. */
export function excludedAreas(candidates: Candidate[], included: Set<string>, scopeStatement: string): Coverage['excluded'] {
  const excluded: Coverage['excluded'] = [];
  for (const [area, group] of byArea(candidates)) {
    if (group.some((c) => included.has(c.controlId))) continue;
    excluded.push({ processArea: area, reason: statementExcludes(scopeStatement, area) ? REASON.statement : REASON.threshold });
  }
  return excluded;
}

/** The fixed sentence: "<n> of <m> library controls across <a> process areas are in scope; <x> area(s) excluded: <names>." or "...; no area excluded." */
export function coverageStatement(candidates: Candidate[], included: Set<string>, excluded: Coverage['excluded']): string {
  const inScope = candidates.filter((c) => included.has(c.controlId));
  const areas = new Set(inScope.map((c) => c.processArea)).size;
  const head = `${inScope.length} of ${candidates.length} library controls across ${areas} process areas are in scope; `;
  if (excluded.length === 0) return `${head}no area excluded.`;
  const names = excluded.map((e) => e.processArea).join(', ');
  return `${head}${excluded.length} ${excluded.length === 1 ? 'area' : 'areas'} excluded: ${names}.`;
}

/** True when the statement names every excluded area (case-insensitive substring). */
export function statementCoversAll(statement: string, excluded: Coverage['excluded']): boolean {
  const text = statement.toLowerCase();
  return excluded.every((e) => text.includes(e.processArea.toLowerCase()));
}
