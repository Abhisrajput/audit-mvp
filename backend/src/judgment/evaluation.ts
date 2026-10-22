// Evaluation rules (spec §5.4): how widespread the exceptions are, and whether a
// person's tolerance makes a result effective. Pure: no I/O, no model calls.

import type { Severity, TestInput, TestResult } from '../engine/types';

/** How widespread test exceptions are, in worsening order. */
export const SEVERITIES: readonly Severity[] = ['none', 'isolated', 'systemic', 'pervasive'];

/** §5.4: an exception rate at or below this, with a single exception or more, is isolated. */
export const ISOLATED_MAX_RATE = 0.1;

/** §5.4: the severity the rule gives. Design deficient is always systemic; pervasive is never set by the rule. */
export function severityOf(result: Pick<TestResult, 'conclusion' | 'exceptionRate'>, input: Pick<TestInput, 'exceptions'> | undefined): { severity: Severity; rationale: string } {
  if (result.conclusion === 'Design deficient') {
    return { severity: 'systemic', rationale: 'The design is deficient, so the weakness is systemic whatever the exception count.' };
  }
  const exceptions = input?.exceptions ?? 0;
  if (exceptions === 0) {
    return { severity: 'none', rationale: 'No exceptions were recorded.' };
  }
  if (exceptions === 1 || (result.exceptionRate !== null && result.exceptionRate <= ISOLATED_MAX_RATE)) {
    return { severity: 'isolated', rationale: `${exceptions} exception${exceptions === 1 ? '' : 's'}: a single exception or a rate of ${ISOLATED_MAX_RATE} or less is isolated.` };
  }
  return { severity: 'systemic', rationale: `${exceptions} exceptions at a rate above ${ISOLATED_MAX_RATE}: the failure is systemic.` };
}

/** §5.4: a proposed severity is worse only when it is strictly later in SEVERITIES. */
export function worsens(rule: Severity, proposed: Severity): boolean {
  return SEVERITIES.indexOf(proposed) > SEVERITIES.indexOf(rule);
}

/** §5.4: with a tolerance in force, the result is effective when the exception rate is within it. A zero tolerance never makes a result effective. */
export function toleratedEffective(exceptions: number, sampleTested: number, rate: number): boolean {
  return rate > 0 && exceptions / sampleTested <= rate;
}
