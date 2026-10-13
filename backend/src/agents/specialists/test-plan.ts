import type { Engagement, TestPlan } from '../../engine/types';
import { rcmRowHash } from '../subjects';

/**
 * Drafts a test plan for each RCM row (spec §3.1) from what the RCM already says: the control objective is the
 * attribute tested, and the RCM's sample size, evidence and procedure carry over. A plan whose row has not changed
 * is kept exactly as it is, including a person's edits. A person's reason for not testing a row is carried over even
 * when the row changed: the agent never sets or clears it. Plans for rows that are gone are dropped.
 */
export function draftTestPlans(e: Engagement): Record<string, TestPlan> {
  const plans: Record<string, TestPlan> = {};
  for (const row of e.rcm) {
    const existing = e.testPlans[row.id];
    const rowHash = rcmRowHash(row);
    if (existing?.rowHash === rowHash) {
      plans[row.id] = existing;
      continue;
    }
    const draft: TestPlan = {
      rowId: row.id,
      rowHash,
      attribute: row.objective,
      population: `Every performance of "${row.control}" (${row.frequency.toLowerCase()}) from ${e.periodFrom} to ${e.periodTo}`,
      sampleSize: row.sampleSize,
      selectionMethod: row.frequency === 'Annual' ? 'all' : 'random',
      evidenceToRequest: [...row.evidenceExpected],
      procedure: row.testOfEffectiveness.join('\n'),
    };
    if (existing?.notTestedJustification) {
      draft.notTestedJustification = existing.notTestedJustification;
      if (existing.editedBy) draft.editedBy = existing.editedBy;
      if (existing.editedAt) draft.editedAt = existing.editedAt;
    }
    plans[row.id] = draft;
  }
  return plans;
}
