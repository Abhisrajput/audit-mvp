import { describe, expect, it } from 'vitest';
import { draftIssues } from '../src/agents/qa/drafts';
import type { TestDraft } from '../src/engine/types';

const draft = (over: Partial<TestDraft> = {}): TestDraft => ({
  rowId: 'A', proposal: { designAdequate: true, sampleTested: 2, exceptions: 0, observation: 'Both logs are signed.' },
  evidence: [{ documentId: 'DOC-1', page: 1, quote: 'signed' }], couldNotVerify: [], confidence: 'medium',
  qa: { blocking: [], advisory: [] }, draftedBy: { runId: 'RUN-1', at: 't', model: 'm' }, ...over,
});

describe('draft QA flags', () => {
  it('a clean draft has no flags, and a draft without a proposal has none either', () => {
    expect(draftIssues(draft())).toEqual({ blocking: [], advisory: [] });
    const { proposal: _, ...none } = draft();
    expect(draftIssues({ ...none, evidence: [] })).toEqual({ blocking: [], advisory: [] });
  });

  it('exceptions above the sample are draft-exceeds-sample (blocking)', () => {
    expect(draftIssues(draft({ proposal: { designAdequate: true, sampleTested: 2, exceptions: 3, observation: 'x' } })).blocking).toContain('draft-exceeds-sample');
  });

  it('a proposal with a sample and no quotes is draft-no-evidence (blocking); with no sample it is not', () => {
    expect(draftIssues(draft({ evidence: [] })).blocking).toEqual(['draft-no-evidence']);
    expect(draftIssues(draft({ evidence: [], proposal: { designAdequate: null, sampleTested: 0, exceptions: 0, observation: 'x' } })).blocking).toEqual([]);
  });

  it('wording that reads like an exception beside a no-exception proposal is advisory only', () => {
    const issues = draftIssues(draft({ proposal: { designAdequate: true, sampleTested: 2, exceptions: 0, observation: 'Two logs were unsigned.' } }));
    expect(issues).toEqual({ blocking: [], advisory: ['draft.negative-signal'] });
    expect(draftIssues(draft({ proposal: { designAdequate: true, sampleTested: 2, exceptions: 1, observation: 'Two logs were unsigned.' } })).advisory).toEqual([]);
    expect(draftIssues(draft({ proposal: { designAdequate: false, sampleTested: 2, exceptions: 0, observation: 'Two logs were unsigned.' } })).advisory).toEqual([]);
  });
});
