import { describe, expect, it } from 'vitest';
import { assertDraftsWithinRails, assertWithinRails, keepScopeDecisions } from '../src/agents/rails';
import type { Engagement, SignOff, TestDraft } from '../src/engine/types';
import { engagement, finding, input, row, scopeItem } from './agent-fixtures';

const signOff: SignOff = { userId: 'reviewer', userName: 'R', role: 'reviewer', meaning: 'Reviewed', comment: '', at: 't' };
const base = () => engagement({ rcm: [row('R1')], testInputs: { R1: input() }, findings: [finding('R1')] });

describe('assertWithinRails', () => {
  it('passes an untouched engagement [REQ-27]', () => {
    expect(() => assertWithinRails(base(), base())).not.toThrow();
  });

  it('refuses a changed, added or removed test input [REQ-27]', () => {
    const changed = base();
    changed.testInputs.R1.exceptions = 9;
    const added = base();
    added.testInputs.R2 = input();
    const removed = base();
    delete removed.testInputs.R1;
    for (const after of [changed, added, removed]) expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses an agent write that sets or changes a tolerance or a management response [REQ-33]', () => {
    const tolerance = { controlId: 'X', rate: 0.05, recordedBy: 'auditor', recordedAt: 't', trailBundleId: 'HUM-1' };
    expect(() => assertWithinRails(base(), { ...base(), tolerances: { X: tolerance } })).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
    const response = { findingId: 'F1' } as unknown as Engagement['responses'][string];
    expect(() => assertWithinRails(base(), { ...base(), responses: { F1: response } })).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses a sign-off added to an existing draft finding [REQ-27]', () => {
    const after = base();
    after.findings[0].signOffs.push(signOff);
    expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses a new finding that already carries a sign-off [REQ-27]', () => {
    const after = base();
    after.findings.push(finding('R2', 'draft', { signOffs: [signOff] }));
    expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses an agent write that adds or changes who decided a scope item [REQ-27]', () => {
    const before = engagement({ scope: [scopeItem('A', true), scopeItem('B', false, { decidedBy: 'auditor' })] });
    const added = engagement({ scope: [scopeItem('A', true, { decidedBy: 'auditor' }), scopeItem('B', false, { decidedBy: 'auditor' })] });
    const changed = engagement({ scope: [scopeItem('A', true), scopeItem('B', false, { decidedBy: 'agent:scope' })] });
    const dropped = engagement({ scope: [scopeItem('A', true), scopeItem('B', false)] });
    for (const after of [added, changed, dropped]) expect(() => assertWithinRails(before, after)).toThrow(expect.objectContaining({ status: 403, code: 'AGENT_FORBIDDEN' }));
    const carried = engagement({ scope: [scopeItem('A', false), scopeItem('B', false, { decidedBy: 'auditor' })] });
    expect(() => assertWithinRails(before, carried)).not.toThrow();
  });
});

const draft = (rowId: string, over: Partial<TestDraft> = {}): TestDraft => ({
  rowId, evidence: [], couldNotVerify: [], confidence: 'low', qa: { blocking: [], advisory: [] }, draftedBy: { runId: 'RUN-1', at: 't', model: 'm' }, ...over,
});

describe('assertWithinRails: drafts', () => {
  it('allows a draft for an untested row, refuses one for a tested row, a person-edited draft, or a deleted draft [REQ-41]', () => {
    const before = base();
    const added = base();
    added.testDrafts.R2 = draft('R2');
    expect(() => assertWithinRails(before, added)).not.toThrow();
    const tested = base();
    tested.testDrafts.R1 = draft('R1');
    expect(() => assertWithinRails(before, tested)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN', message: expect.stringContaining('R1') }));
    const edited = engagement({ testDrafts: { R2: draft('R2', { personEdited: true }) } });
    const redraft = engagement({ testDrafts: { R2: draft('R2', { confidence: 'high' }) } });
    expect(() => assertDraftsWithinRails(edited, redraft)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
    const agentOwned = engagement({ testDrafts: { R2: draft('R2') } });
    expect(() => assertDraftsWithinRails(agentOwned, engagement())).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
    expect(() => assertDraftsWithinRails(agentOwned, redraft)).not.toThrow();
  });
});

describe('assertDraftsWithinRails: person-edited', () => {
  it('refuses an agent marking a new draft personEdited, and passes an untouched personEdited draft [REQ-41]', () => {
    const marked = engagement({ testDrafts: { R2: draft('R2', { personEdited: true }) } });
    expect(() => assertDraftsWithinRails(engagement(), marked)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
    const a = engagement({ rcm: [row('R2')], testDrafts: { R2: draft('R2', { personEdited: true }) } });
    expect(() => assertWithinRails(a, structuredClone(a))).not.toThrow();
  });
});

describe('keepScopeDecisions', () => {
  it("pins the in/out flags people decided and lets the fresh rules decide the agent's own [REQ-27]", () => {
    const previous = [scopeItem('PERSON-OUT', false, { decidedBy: 'auditor' }), scopeItem('PERSON-IN', true, { decidedBy: 'auditor' }), scopeItem('AGENT', false)];
    const next = [scopeItem('AGENT', true), scopeItem('PERSON-IN', false), scopeItem('PERSON-OUT', true), scopeItem('NEW', true)];
    keepScopeDecisions(previous, next);
    const by = Object.fromEntries(next.map((s) => [s.controlId, s]));
    expect(by['PERSON-OUT']).toMatchObject({ included: false, decidedBy: 'auditor' });
    expect(by['PERSON-IN']).toMatchObject({ included: true, decidedBy: 'auditor' });
    expect(by.AGENT.included).toBe(true);
    expect('decidedBy' in by.AGENT).toBe(false);
    expect(by.NEW.included).toBe(true);
  });
});
