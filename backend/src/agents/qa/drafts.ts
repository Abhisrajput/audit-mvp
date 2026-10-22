import { negativeSignals } from '../../engine/qa';
import type { TestDraft } from '../../engine/types';

// The checks on an agent's draft test result (spec §9.1). Blocking flags keep a draft from offering a proposal; advisory
// ones ride along for the person. `unsupported-quote` is added by the specialist, which has the document text.

const MIN_QUOTE = 20;

export function draftIssues(draft: TestDraft): { blocking: string[]; advisory: string[] } {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const p = draft.proposal;
  if (p) {
    if (p.exceptions > p.sampleTested) blocking.push('draft-exceeds-sample');
    if (p.sampleTested > 0 && draft.evidence.length === 0) blocking.push('draft-no-evidence');
    // The testing module's rule: wording that reads like an exception beside a proposal that would conclude Effective.
    if (negativeSignals(p.observation).length > 0 && p.designAdequate !== false && p.exceptions === 0) advisory.push('draft.negative-signal');
  }
  // A one-word quote proves nothing; it is for the person to judge, not a reason to block.
  if (draft.evidence.some((x) => x.quote.replace(/\s+/g, ' ').trim().length < MIN_QUOTE)) advisory.push('draft.short-quote');
  return { blocking, advisory };
}
