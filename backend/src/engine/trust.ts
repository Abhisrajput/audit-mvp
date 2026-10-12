import type { PackRegistry } from './packs';
import type { ConceptTrust, QaAction } from './types';

// Trust rules for citing library knowledge (spec §6.4, REQ-22). A clause or control is citable only
// when a person has verified it, it is active, and its re-review date has not arrived. Unverified
// sources block release unless the policy allows them (outside production only); stale ones are flagged.

export interface CitationPolicy {
  /** ALLOW_UNVERIFIED_CITATIONS: flag instead of block. Refused in production (config.ts). */
  allowUnverified: boolean;
}

export const STRICT_CITATIONS: CitationPolicy = { allowUnverified: false };

export type TrustProblem = 'UNVERIFIED_SOURCE' | 'STALE_SOURCE';

/** Today's date in UTC, 'YYYY-MM-DD'. */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export function trustProblems(trust: ConceptTrust | undefined, today = todayUtc()): TrustProblem[] {
  const problems: TrustProblem[] = [];
  // A deprecated concept is reported as UNVERIFIED_SOURCE too: there is no separate code, and it is
  // equally not vouched for by a reviewer in its current form.
  if (!trust?.verifiedBy || trust.status !== 'active') problems.push('UNVERIFIED_SOURCE');
  if (trust?.staleAfter && trust.staleAfter <= today) problems.push('STALE_SOURCE');
  return problems;
}

export const isCitable = (trust: ConceptTrust | undefined, today = todayUtc()) => trustProblems(trust, today).length === 0;

/** Gate actions for the clauses (and control) one finding or RCM row cites. */
export function trustActions(
  registry: PackRegistry,
  target: string,
  cited: { clauseIds: string[]; controlId?: string },
  policy: CitationPolicy,
  today = todayUtc(),
): QaAction[] {
  const sources: { id: string; trust: ConceptTrust | undefined }[] = [];
  for (const id of new Set(cited.clauseIds)) {
    const c = registry.clauses.get(id);
    if (c) sources.push({ id, trust: c.trust });
  }
  const control = cited.controlId ? registry.controls.get(cited.controlId) : undefined;
  if (control) sources.push({ id: control.id, trust: control.trust });
  if (!sources.length) return [];

  const having = (p: TrustProblem) => sources.filter((s) => trustProblems(s.trust, today).includes(p)).map((s) => s.id);
  const unverified = having('UNVERIFIED_SOURCE');
  const stale = having('STALE_SOURCE');
  const actions: QaAction[] = [];
  if (unverified.length) {
    actions.push(policy.allowUnverified
      ? { gate: 'trust', outcome: 'warn', target, detail: `UNVERIFIED_SOURCE: ${unverified.join(', ')} not yet verified by a reviewer (allowed outside production)`, action: 'flagged' }
      : { gate: 'trust', outcome: 'fail', target, detail: `UNVERIFIED_SOURCE: ${unverified.join(', ')} not verified by a reviewer`, action: 'blocked' });
  }
  if (stale.length) {
    actions.push({ gate: 'trust', outcome: 'warn', target, detail: `STALE_SOURCE: ${stale.join(', ')} past re-review date`, action: 'flagged' });
  }
  if (!actions.length) actions.push({ gate: 'trust', outcome: 'pass', target, detail: `${sources.length} source(s) verified and current`, action: 'none' });
  return actions;
}
