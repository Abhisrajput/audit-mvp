import type { Finding } from '../../src/engine/types';

/** A finding with every content field set, as written before evidence links existed. Its hash is pinned in evidence-links.test.ts. */
export const FIXED_FINDING: Finding = {
  id: 'F-FIXED-1',
  rowId: 'R-7',
  controlId: 'C-ACCESS-1',
  title: 'Access reviews are not performed quarterly',
  rating: 'Medium',
  condition: 'Two of 25 reviews were missing.',
  criteria: 'Quarterly access reviews are required. Control objective: keep access appropriate.',
  cause: 'Owner left; no delegate.',
  effect: 'Inappropriate access may persist.',
  recommendation: 'Assign a delegate and evidence each review.',
  citations: [{ clauseId: 'CL-1', regulation: 'ISO 27001', ref: 'A.5.18', label: 'ISO 27001 A.5.18' }],
  evidenceRefs: ['EV-1', 'EV-2'],
  status: 'draft',
  blockedReasons: [],
  signOffs: [],
  bundleId: 'RUN-abcd1234',
  likelihood: 'likely',
  impact: 'moderate',
  rootCause: { category: 'process', analysis: 'No delegate when the owner left.', confirmed: false },
  memo: { subjectKey: 'finding:R-7', calls: [], forTheReviewer: ['Check the sample'], producedAt: '2026-01-01T00:00:00.000Z' },
  preparedBy: ['auditor'],
};
