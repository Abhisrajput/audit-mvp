// Finding rules (spec §5.5): how likely the exposure is, how serious, the rating the
// two give, and the string test that a root cause must pass. Pure: no I/O, no model calls.

import type { Impact, Likelihood, RiskRating, TestResult } from '../engine/types';

/** Likelihood below this exception rate (above zero) is rare. */
export const RARE_BELOW = 0.05;
/** Likelihood at or above this exception rate is likely. */
export const LIKELY_FROM = 0.2;

/** Likelihoods from lowest to highest, so a step is a move along this list. */
export const LIKELIHOODS: readonly Likelihood[] = ['rare', 'possible', 'likely'];
/** Impacts from lowest to highest, so a step is a move along this list. */
export const IMPACTS: readonly Impact[] = ['minor', 'moderate', 'major'];

/** §5.5: the rating for each impact and likelihood. */
export const MATRIX: Record<Impact, Record<Likelihood, RiskRating>> = {
  major: { rare: 'Medium', possible: 'High', likely: 'High' },
  moderate: { rare: 'Medium', possible: 'Medium', likely: 'High' },
  minor: { rare: 'Low', possible: 'Low', likely: 'Low' },
};

/** §5.5: the root cause the rule writes; a person or the model replaces it. */
export const PLACEHOLDER_CAUSE = 'Root cause to be confirmed with the process owner at the exit meeting.';

/** §5.5: impact follows the assessed risk of the row. */
export function impactOf(assessedRisk: RiskRating): Impact {
  return assessedRisk === 'High' ? 'major' : assessedRisk === 'Medium' ? 'moderate' : 'minor';
}

/** §5.5: likelihood follows the exception rate; a design deficiency or a zero rate is possible. */
export function likelihoodOf(result: Pick<TestResult, 'conclusion' | 'exceptionRate'>): Likelihood {
  if (result.conclusion === 'Design deficient') return 'possible';
  const rate = result.exceptionRate ?? 0;
  if (rate > 0 && rate < RARE_BELOW) return 'rare';
  if (rate >= LIKELY_FROM) return 'likely';
  return 'possible';
}

/** §5.5: the finding's rating is always the matrix cell for its likelihood and impact. */
export function ratingOf(likelihood: Likelihood, impact: Impact): RiskRating {
  return MATRIX[impact][likelihood];
}

/** §5.5: a model may move likelihood or impact exactly one step later in the order, never two and never back. */
export function oneStepWorse<T extends Likelihood | Impact>(order: readonly T[], rule: T, proposed: T): boolean {
  return order.indexOf(proposed) === order.indexOf(rule) + 1;
}

/** Audit-common words that cannot confirm a cause on their own (the string-overlap check of §5.5). */
export const CAUSE_STOP_WORDS: readonly string[] = [
  'control', 'controls', 'process', 'because', 'performed', 'recorded', 'evidence', 'review', 'reviewed', 'sample', 'sampled',
  'exception', 'exceptions', 'testing', 'tested', 'finding', 'procedure', 'management', 'monthly', 'quarterly', 'during', 'period',
  'without', 'should',
];

/** §5.5: a cause is supported when the observation and the analysis share a word of six or more letters that is not a stop word. */
export function causeSupported(observation: string, analysis: string): boolean {
  const words = (text: string) => new Set(
    (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 6 && !CAUSE_STOP_WORDS.includes(word)),
  );
  const observed = words(observation);
  for (const word of words(analysis)) {
    if (observed.has(word)) return true;
  }
  return false;
}
