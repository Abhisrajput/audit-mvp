import { describe, expect, it } from 'vitest';
import { acceptable, confidenceColor, draftToForm } from './drafting';
import type { TestDraft } from './types';

const base = (over: Partial<TestDraft> = {}): TestDraft => ({
  rowId: 'r1',
  evidence: [],
  couldNotVerify: [],
  confidence: 'high',
  qa: { blocking: [], advisory: [] },
  draftedBy: { runId: 'run1', at: '2026-10-22T00:00:00Z', model: 'm' },
  ...over,
});

describe('draftToForm', () => {
  it('turns the proposal into form strings and evidence into links without quotes', () => {
    const d = base({
      proposal: { designAdequate: true, sampleTested: 25, exceptions: 2, observation: 'Two approvals missing.' },
      evidence: [{ documentId: 'd1', page: 3, quote: 'q' }, { documentId: 'd2', quote: 'r' }],
    });
    expect(draftToForm(d)).toEqual({
      designAdequate: 'yes',
      sampleTested: '25',
      exceptions: '2',
      observation: 'Two approvals missing.',
      evidence: [{ documentId: 'd1', page: 3 }, { documentId: 'd2' }],
    });
  });
  it('maps design adequacy false and null', () => {
    const p = { sampleTested: 0, exceptions: 0, observation: '' };
    expect(draftToForm(base({ proposal: { ...p, designAdequate: false } })).designAdequate).toBe('no');
    expect(draftToForm(base({ proposal: { ...p, designAdequate: null } })).designAdequate).toBe('na');
  });
  it('dedupes evidence by document and page', () => {
    const d = base({ evidence: [{ documentId: 'd1', page: 3, quote: 'a' }, { documentId: 'd1', page: 3, quote: 'b' }, { documentId: 'd1', page: 4, quote: 'c' }] });
    expect(draftToForm(d).evidence).toEqual([{ documentId: 'd1', page: 3 }, { documentId: 'd1', page: 4 }]);
  });
  it('yields only evidence when there is no proposal', () => {
    expect(draftToForm(base({ evidence: [{ documentId: 'd1', quote: 'a' }] }))).toEqual({ evidence: [{ documentId: 'd1' }] });
  });
});

describe('acceptable', () => {
  const proposal = { designAdequate: true, sampleTested: 1, exceptions: 0, observation: 'x' };
  it('needs a proposal and no blocking flags', () => {
    expect(acceptable(base({ proposal }))).toBe(true);
    expect(acceptable(base({ proposal, qa: { blocking: ['b'], advisory: [] } }))).toBe(false);
    expect(acceptable(base())).toBe(false);
    expect(acceptable(base({ personEdited: true }))).toBe(false);
    expect(acceptable(base({ proposal, qa: { blocking: [], advisory: ['a'] } }))).toBe(true);
  });
});

describe('confidenceColor', () => {
  it('maps confidence to chip colours', () => {
    expect(confidenceColor('high')).toBe('success');
    expect(confidenceColor('medium')).toBe('warning');
    expect(confidenceColor('low')).toBe('default');
    expect(confidenceColor('weird' as never)).toBe('default');
  });
});
