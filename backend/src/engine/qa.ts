import type { PackRegistry } from './packs';
import { toleratedEffective } from '../judgment/evaluation';
import { trustActions, type CitationPolicy } from './trust';
import type { Citation, Finding, QaAction, RcmRow, TestInput, TestResult } from './types';

// Runtime QA gates. They run on every module output regardless of whether a
// model or the offline rules produced it, and every decision is written to the
// audit trail. A gate that fails either blocks the output from release,
// downgrades it, or flags it for the human reviewer.

export function toCitation(registry: PackRegistry, clauseId: string): Citation | null {
  const c = registry.clauses.get(clauseId);
  return c ? { clauseId: c.id, regulation: c.regulation, ref: c.ref, label: registry.citationLabel(c.id) } : null;
}

/** Citation gate for RCM rows: every row must cite at least one known clause. */
export function rcmCitationGate(registry: PackRegistry, row: RcmRow): QaAction {
  const unknown = row.citations.filter((c) => !registry.clauses.has(c.clauseId));
  if (row.citations.length === 0 || unknown.length > 0) {
    return {
      gate: 'citation',
      outcome: 'fail',
      target: row.id,
      detail: row.citations.length === 0 ? 'Row has no regulatory citation' : `Unknown clauses: ${unknown.map((c) => c.clauseId).join(', ')}`,
      action: 'blocked',
    };
  }
  return { gate: 'citation', outcome: 'pass', target: row.id, detail: `${row.citations.length} citation(s) verified`, action: 'none' };
}

const NEGATIVE_SIGNALS = [
  'missing', 'not signed', 'unsigned', 'not performed', 'not available', 'no evidence', 'no record',
  'expired', 'overdue', 'late', 'incomplete', 'not reviewed', 'not approved', 'shared account',
  'disabled', 'not documented', 'not updated', 'exceeded', 'breach', 'without approval', 'not reconciled',
];

export function negativeSignals(text: string): string[] {
  const t = text.toLowerCase();
  return NEGATIVE_SIGNALS.filter((s) => t.includes(s));
}

/**
 * Evidence gate for test conclusions. An "Effective" conclusion needs evidence
 * references and a sample; it can never stand when exceptions were recorded;
 * and a narrative that reads like an exception is flagged for the reviewer.
 */
export function testEvidenceGate(row: RcmRow, input: TestInput, result: TestResult, tolerance = 0): { result: TestResult; actions: QaAction[] } {
  const actions: QaAction[] = [];
  let r = { ...result, qaFlags: [...result.qaFlags] };

  if (r.conclusion === 'Effective' && input.exceptions > 0 && !toleratedEffective(input.exceptions, input.sampleTested, tolerance)) {
    actions.push({ gate: 'evidence', outcome: 'fail', target: row.id, detail: `Conclusion "Effective" contradicts ${input.exceptions} recorded exception(s)`, action: 'downgraded' });
    r = { ...r, conclusion: 'Ineffective', rationale: `${r.rationale} [QA gate: overridden to Ineffective because exceptions were recorded.]` };
  }
  if (r.conclusion === 'Effective' && input.evidenceRefs.length === 0) {
    actions.push({ gate: 'evidence', outcome: 'fail', target: row.id, detail: 'No evidence reference recorded for an "Effective" conclusion', action: 'downgraded' });
    r = { ...r, conclusion: 'Not tested', rationale: `${r.rationale} [QA gate: no evidence reference, so the control cannot be concluded effective.]` };
    r.qaFlags.push('No evidence reference');
  }
  if (r.conclusion === 'Effective' && input.sampleTested < row.sampleSize) {
    actions.push({ gate: 'sample', outcome: 'warn', target: row.id, detail: `Sample tested ${input.sampleTested} is below planned ${row.sampleSize}`, action: 'flagged' });
    r.qaFlags.push(`Sample ${input.sampleTested}/${row.sampleSize} below plan`);
  }
  const signals = negativeSignals(input.observation);
  if (r.conclusion === 'Effective' && signals.length > 0) {
    actions.push({ gate: 'consistency', outcome: 'warn', target: row.id, detail: `Observation mentions "${signals.join('", "')}" but concludes Effective`, action: 'flagged' });
    r.qaFlags.push('Observation wording suggests an exception');
  }
  if (actions.length === 0) {
    actions.push({ gate: 'evidence', outcome: 'pass', target: row.id, detail: `Conclusion "${r.conclusion}" consistent with recorded evidence`, action: 'none' });
  }
  return { result: r, actions };
}

/**
 * Triple-citation gate for findings: (1) at least one regulatory clause that
 * exists and was in the grounding set given to the drafter, (2) the control it
 * tests, (3) at least one evidence reference. Missing any leg blocks release.
 * (4) every cited clause and the control are citable under the trust rules (REQ-22); an unverified
 * source blocks release unless the policy allows it.
 */
export function findingCitationGate(
  registry: PackRegistry,
  finding: Finding,
  allowedClauseIds: Set<string>,
  policy: CitationPolicy,
): { finding: Finding; actions: QaAction[] } {
  const reasons: string[] = [];
  const actions: QaAction[] = [];

  const unknown = finding.citations.filter((c) => !registry.clauses.has(c.clauseId));
  const ungrounded = finding.citations.filter((c) => registry.clauses.has(c.clauseId) && !allowedClauseIds.has(c.clauseId));
  if (finding.citations.length === 0) reasons.push('No regulatory clause cited');
  if (unknown.length) reasons.push(`Cites clauses not in the corpus: ${unknown.map((c) => c.clauseId).join(', ')}`);
  if (ungrounded.length) reasons.push(`Cites clauses outside the grounding set: ${ungrounded.map((c) => c.clauseId).join(', ')}`);
  if (!registry.controls.has(finding.controlId)) reasons.push(`Unknown control ${finding.controlId}`);
  if (finding.evidenceRefs.length === 0) reasons.push('No evidence reference');

  const trust = trustActions(
    registry,
    finding.id,
    { clauseIds: finding.citations.map((c) => c.clauseId), controlId: finding.controlId },
    policy,
  );
  reasons.push(...trust.filter((a) => a.action === 'blocked').map((a) => a.detail));

  if (reasons.length) {
    actions.push({ gate: 'triple-citation', outcome: 'fail', target: finding.id, detail: reasons.join('; '), action: 'blocked' });
    return { finding: { ...finding, status: 'blocked', blockedReasons: reasons }, actions: [...actions, ...trust] };
  }

  actions.push({ gate: 'triple-citation', outcome: 'pass', target: finding.id, detail: `Clause(s) ${finding.citations.map((c) => c.ref).join(', ')} + control ${finding.controlId} + ${finding.evidenceRefs.length} evidence ref(s)`, action: 'none' });

  const unmentioned = finding.citations.filter((c) => !finding.criteria.includes(c.ref));
  if (unmentioned.length) {
    actions.push({ gate: 'criteria-traceability', outcome: 'warn', target: finding.id, detail: `Criteria text does not mention ${unmentioned.map((c) => c.ref).join(', ')}`, action: 'flagged' });
  }
  return { finding: { ...finding, blockedReasons: [] }, actions: [...actions, ...trust] };
}
