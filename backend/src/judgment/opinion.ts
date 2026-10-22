// The engagement opinion (spec §5.6): a rule over the approved findings, and the helpers around it. Pure: no I/O.

import { canonicalJson, sha256 } from '../engine/trail';
import type { Coverage, Finding, Opinion } from '../engine/types';
import { findingContentHash } from '../signing/content-hash';

/** The opinions, best to worst. */
export const OPINIONS: readonly Opinion[] = ['satisfactory', 'needs_improvement', 'unsatisfactory'];

/** The rule: unsatisfactory on any approved High, needs improvement on any approved Medium, else satisfactory. Other statuses do not count. */
export function opinionOf(findings: Pick<Finding, 'rating' | 'status'>[]): Opinion {
  const approved = findings.filter((f) => f.status === 'approved');
  if (approved.some((f) => f.rating === 'High')) return 'unsatisfactory';
  if (approved.some((f) => f.rating === 'Medium')) return 'needs_improvement';
  return 'satisfactory';
}

/** Whether the proposed opinion is strictly worse than the rule's. */
export function worsens(rule: Opinion, proposed: Opinion): boolean {
  return OPINIONS.indexOf(proposed) > OPINIONS.indexOf(rule);
}

/** The fixed basis paragraph under the opinion: finding counts, rows tested, areas covered and excluded. */
export function opinionBasisText(input: { approved: Pick<Finding, 'rating'>[]; coverage: Coverage | null; rowsTested: number; rowsInScope: number; areasCovered: string[] }): string {
  const count = (r: Finding['rating']) => input.approved.filter((f) => f.rating === r).length;
  const parts = [
    `${input.approved.length} approved finding(s): ${count('High')} High, ${count('Medium')} Medium, ${count('Low')} Low.`,
    `${input.rowsTested} of ${input.rowsInScope} in-scope controls were tested.`,
    `Areas covered: ${input.areasCovered.join(', ')}.`,
  ];
  if (!input.coverage) parts.push('No coverage statement was recorded.');
  else parts.push(`Areas excluded: ${input.coverage.excluded.length === 0 ? 'none' : input.coverage.excluded.map((e) => `${e.processArea} (${e.reason})`).join(', ')}.`);
  return parts.join(' ');
}

const DIRECTIVE = /\bopinion\s*:\s*([A-Za-z_]+)/i;

/** An opinion named in a rejection comment ("opinion: needs_improvement"); a problem when the value is unknown; null when the comment names none. */
export function parseOpinionDirective(comment: string): { opinion: Opinion } | { problem: string } | null {
  const match = DIRECTIVE.exec(comment);
  if (!match) return null;
  const value = match[1].toLowerCase();
  const opinion = OPINIONS.find((o) => o === value);
  if (opinion) return { opinion };
  return { problem: `The rejection names an opinion "${match[1]}" that is not one of ${OPINIONS.join(', ')}; the rule's opinion applies.` };
}

/** sha256 over the approved findings' ids and content hashes, in id order: what an opinion was computed from. */
export function approvedFindingsFingerprint(findings: Finding[]): string {
  const approved = findings
    .filter((f) => f.status === 'approved')
    .map((f) => ({ id: f.id, hash: findingContentHash(f) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(canonicalJson(approved));
}
