import { describe, expect, it } from 'vitest';
import { allowedActions } from '../src/agents/graph';
import { findingKey, rcmRowHash, subjectInfo } from '../src/agents/subjects';
import type { Action, GateRecord, GateState, GraphInput, Menu, QaIssue, QaReport, RedraftRecord } from '../src/agents/types';
import type { Citation, Engagement, Finding, RcmRow, ScopeItem, TestInput, TestPlan, TestResult } from '../src/engine/types';

// The graph is a pure function: these tests build engagements in memory and read the menu it offers.

const cite: Citation = { clauseId: 'C1', regulation: 'Reg', ref: '§1', label: 'Reg §1' };
const scopeItem = (id: string, included = true): ScopeItem => ({
  controlId: id, packId: 'p', processArea: 'a', risk: 'r', inherentRisk: 'Medium', relevance: 1, rationale: 'x', citations: [cite], included,
});
const row = (id: string): RcmRow => ({
  id, controlId: id, packId: 'p', processArea: 'a', risk: 'r', riskRating: 'Medium', control: `Control ${id}`, objective: 'o', type: 'Preventive',
  nature: 'Manual', frequency: 'Monthly', sampleSize: 2, testOfDesign: ['d'], testOfEffectiveness: ['t'], evidenceExpected: ['ev'], checklist: [], citations: [cite],
});
const plan = (r: RcmRow, over: Partial<TestPlan> = {}): TestPlan => ({
  rowId: r.id, rowHash: rcmRowHash(r), attribute: 'a', population: 'p', sampleSize: 2, selectionMethod: 'random', evidenceToRequest: ['ev'], procedure: 't', ...over,
});
const input = (exceptions = 1): TestInput => ({ designAdequate: true, observation: 'o', evidenceRefs: ['E1'], sampleTested: 2, exceptions, updatedBy: 'auditor', updatedAt: 't' });
const result = (rowId: string, conclusion: TestResult['conclusion'] = 'Ineffective'): TestResult => ({ rowId, conclusion, rationale: 'x', exceptionRate: 0.5, qaFlags: [] });
const finding = (rowId: string, status: Finding['status'] = 'draft'): Finding => ({
  id: `F-${rowId}`, rowId, controlId: rowId, title: 't', rating: 'Medium', condition: 'c', criteria: 'k', cause: 'u', effect: 'f', recommendation: 'r',
  citations: [cite], evidenceRefs: ['E1'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1',
});

function engagement(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'ENG-1', name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'stmt',
    packIds: ['p'], createdBy: 'auditor', createdAt: '2026-01-01T00:00:00.000Z', stage: 'planning', scope: [], rcm: [], testInputs: {},
    testResults: {}, testPlans: {}, findings: [], report: null, ...over,
  };
}

let gateSeq = 0;
function gate(e: Engagement, key: string, state: GateState, over: Partial<GateRecord> = {}): GateRecord {
  const s = subjectInfo(e, key)!;
  const signed = state === 'approved' || state === 'rejected';
  return {
    id: `GATE-${++gateSeq}`, kind: s.gateKind!, subjectKey: key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, state,
    attempt: 1, comment: '', signatureId: signed ? 'SIG-1' : null, ...over,
  };
}
const qa = (e: Engagement, key: string, issues: QaIssue[] = [], score = 100): QaReport => ({
  subjectKey: key, subjectHash: subjectInfo(e, key)!.hash, mode: 'review', reviewer: 'test', score, issues,
});
const blocking: QaIssue = { criterion: 'x', severity: 'blocking', detail: 'broken' };
const advisory: QaIssue = { criterion: 'y', severity: 'advisory', detail: 'odd' };

function menu(e: Engagement, over: Partial<GraphInput> = {}): Menu {
  const m = allowedActions({ engagement: e, gates: [], qa: [], redrafts: [], qaThreshold: 70, ...over });
  // Every state the graph can be asked about offers at least one action.
  expect(m.actions.length).toBeGreaterThan(0);
  return m;
}
const types = (m: Menu) => m.actions.map((a) => a.type);

/** Scope and RCM approved and current. */
function throughRcm() {
  const e = engagement({ scope: [scopeItem('A')], rcm: [row('A')] });
  return { e, gates: [gate(e, 'scope', 'approved'), gate(e, 'rcm', 'approved')] };
}
/** Plus test plans drafted and reviewed. */
function planned() {
  const { e, gates } = throughRcm();
  e.testPlans = { A: plan(e.rcm[0]) };
  return { e, gates, qa: [qa(e, 'test_plans')] };
}

describe('the engagement graph', () => {
  it('delegates the scope first on a new engagement [REQ-26]', () => {
    const m = menu(engagement());
    expect(m.stage).toBe('scope');
    expect(m.actions).toEqual([{ type: 'delegate', specialist: 'scope', subjectKey: 'scope' }]);
  });

  it('asks for QA before any gate, and offers only the gate when QA is clean [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(menu(e).actions).toEqual([{ type: 'request_qa', subjectKey: 'scope', mode: 'review' }]);
    expect(menu(e, { qa: [qa(e, 'scope')] }).actions).toEqual([{ type: 'open_gate', subjectKey: 'scope' }]);
  });

  it('never offers an action past an unapproved gate [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')], rcm: [row('A')] });
    // The RCM was approved once, but the scope gate is open again: the run waits on the scope.
    const m = menu(e, { gates: [gate(e, 'rcm', 'approved'), gate(e, 'scope', 'open')] });
    expect(m.stage).toBe('scope');
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting scope gate signature' }]);
  });

  it('offers the gate, a redraft and escalation after QA issues, within the caps [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(types(menu(e, { qa: [qa(e, 'scope', [advisory], 60)] }))).toEqual(['open_gate', 'rework', 'escalate']);
    expect(types(menu(e, { qa: [qa(e, 'scope', [blocking], 75)] }))).toEqual(['rework', 'escalate']);
    const basis = subjectInfo(e, 'scope')!.basis;
    const twice: RedraftRecord[] = [
      { subjectKey: 'scope', kind: 'rework', basis, sinceGateId: null },
      { subjectKey: 'scope', kind: 'rework', basis, sinceGateId: null },
    ];
    expect(types(menu(e, { qa: [qa(e, 'scope', [blocking], 75)], redrafts: twice }))).toEqual(['escalate']);
    expect(types(menu(e, { qa: [qa(e, 'scope', [advisory], 60)], redrafts: twice }))).toEqual(['open_gate', 'escalate']);
  });

  it("redrafts a rejected workpaper from the signer's comment, then escalates when nothing changed or after two rejections [REQ-26]", () => {
    const e = engagement({ scope: [scopeItem('A')] });
    const rejected = gate(e, 'scope', 'rejected', { comment: 'Add the segregation-of-duties controls' });
    expect(menu(e, { gates: [rejected] }).actions).toEqual([
      { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'Add the segregation-of-duties controls' },
    ]);
    const redrafted: RedraftRecord = { subjectKey: 'scope', kind: 'rework', basis: subjectInfo(e, 'scope')!.basis, sinceGateId: rejected.id };
    expect(menu(e, { gates: [rejected], redrafts: [redrafted] }).actions[0]).toMatchObject({ type: 'escalate', reason: expect.stringMatching(/^rework produced no change: scope/) });
    const twice = [gate(e, 'scope', 'rejected', { attempt: 1 }), gate(e, 'scope', 'rejected', { attempt: 2 })];
    expect(menu(e, { gates: twice }).actions).toEqual([{ type: 'escalate', reason: 'gate_rejected_twice: scope' }]);
  });

  it('sends an approved workpaper edited by hand back through QA, and rebuilds one whose basis changed, once [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A'), scopeItem('B', false)], rcm: [row('A')] });
    const approvedScope = gate(e, 'scope', 'approved');
    const approvedRcm = gate(e, 'rcm', 'approved');
    const edited = structuredClone(e);
    edited.scope[1].included = true;
    expect(menu(edited, { gates: [approvedScope, approvedRcm] }).actions).toEqual([{ type: 'request_qa', subjectKey: 'scope', mode: 'review' }]);

    // The scope was re-approved after the edit, so the RCM was built from an older scope: rebuild it, then review the rebuilt RCM.
    const reapproved = gate(edited, 'scope', 'approved');
    const gates = [approvedScope, approvedRcm, reapproved];
    expect(menu(edited, { gates }).actions).toEqual([{ type: 'delegate', specialist: 'rcm', subjectKey: 'rcm' }]);
    const rebuilt: RedraftRecord = { subjectKey: 'rcm', kind: 'delegate', basis: subjectInfo(edited, 'rcm')!.basis, sinceGateId: approvedRcm.id };
    expect(menu(edited, { gates, redrafts: [rebuilt] }).actions).toEqual([{ type: 'request_qa', subjectKey: 'rcm', mode: 'review' }]);
  });

  it('rebuilds a subject built on a basis that is no longer current, even before its gate is approved [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A'), scopeItem('B', false)], rcm: [row('A')] });
    const builtFrom: RedraftRecord = { subjectKey: 'rcm', kind: 'delegate', basis: subjectInfo(e, 'rcm')!.basis, sinceGateId: null };
    // The scope changed (and was approved again) after the RCM was drafted; the RCM's open gate was superseded.
    const edited = structuredClone(e);
    edited.scope[1].included = true;
    const gates = [gate(edited, 'scope', 'approved')];
    expect(menu(edited, { gates, redrafts: [builtFrom] }).actions).toEqual([{ type: 'delegate', specialist: 'rcm', subjectKey: 'rcm' }]);
    const rebuilt: RedraftRecord = { ...builtFrom, basis: subjectInfo(edited, 'rcm')!.basis };
    expect(menu(edited, { gates, redrafts: [builtFrom, rebuilt] }).actions).toEqual([{ type: 'request_qa', subjectKey: 'rcm', mode: 'review' }]);
  });

  it('drafts test plans after the RCM gate, reviews them without a gate, and waits for field work [REQ-26]', () => {
    const { e, gates } = throughRcm();
    expect(menu(e, { gates }).actions).toEqual([{ type: 'delegate', specialist: 'test-plan', subjectKey: 'test_plans' }]);
    e.testPlans = { A: plan(e.rcm[0]) };
    expect(menu(e, { gates }).actions).toEqual([{ type: 'request_qa', subjectKey: 'test_plans', mode: 'review' }]);
    const m = menu(e, { gates, qa: [qa(e, 'test_plans')] });
    expect(m.stage).toBe('awaiting_tests');
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting test results for 1 control(s)' }]);
  });

  it("does not wait for a row a person decided not to test", () => {
    const { e, gates } = throughRcm();
    e.testPlans = { A: plan(e.rcm[0], { notTestedJustification: 'Control retired in Q1' }) };
    const m = menu(e, { gates, qa: [qa(e, 'test_plans')] });
    expect(m.stage).toBe('report');
    expect(m.actions).toEqual([{ type: 'delegate', specialist: 'report', subjectKey: 'report' }]);
  });

  it('concludes tests, then drafts findings only for the rows that need them [REQ-26]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input() };
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'testing', subjectKey: 'testing' }]);
    e.testResults = { A: result('A') };
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'gaps', subjectKey: 'gaps', rows: ['A'] }]);
  });

  it('waits rather than redraft a finding that is already reviewed [REQ-27]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input(0) };
    e.testResults = { A: result('A', 'Effective') };
    e.findings = [finding('A', 'reviewed')];
    const m = menu(e, { gates, qa: reviews });
    expect(m.actions).toEqual([{ type: 'wait', reason: 'awaiting signatures on reviewed findings before they can be redrafted' }]);
  });

  it('gates each finding, then the report, then completes [REQ-26]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input() };
    e.testResults = { A: result('A') };
    e.findings = [finding('A')];
    const key = findingKey('A');
    expect(menu(e, { gates, qa: [...reviews, qa(e, key)] }).actions).toEqual([{ type: 'open_gate', subjectKey: key }]);
    const open = gate(e, key, 'open');
    expect(menu(e, { gates: [...gates, open], qa: reviews }).actions).toEqual([{ type: 'wait', reason: 'awaiting finding gate signature (F-A)' }]);

    e.findings = [finding('A', 'approved')];
    expect(menu(e, { gates, qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'report', subjectKey: 'report' }]);
    e.report = { generatedAt: 't', bundleId: 'RUN-9', markdown: '# Report', includedFindingIds: ['F-A'], excludedFindingIds: [] };
    expect(menu(e, { gates: [...gates, gate(e, 'report', 'approved')], qa: reviews }).actions).toEqual([{ type: 'complete' }]);
  });

  it('escalates an approved finding whose test results changed after its gate [REQ-26]', () => {
    const { e, gates, qa: reviews } = planned();
    e.testInputs = { A: input() };
    e.testResults = { A: result('A') };
    e.findings = [finding('A', 'approved')];
    const approved = gate(e, findingKey('A'), 'approved');
    expect(menu(e, { gates: [...gates, approved], qa: reviews }).actions).toEqual([{ type: 'delegate', specialist: 'report', subjectKey: 'report' }]);
    e.testInputs = { A: input(3) };
    const m = menu(e, { gates: [...gates, approved], qa: reviews });
    expect(m.stage).toBe('findings');
    expect(m.actions).toEqual([{ type: 'escalate', reason: 'finding F-A was approved on test results that have since changed; a person must decide what to do with it' }]);
  });

  it('holds a clean QA report below the threshold to the same menu as advisory issues [REQ-26]', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(types(menu(e, { qa: [qa(e, 'scope', [], 50)] }))).toEqual(['open_gate', 'rework', 'escalate']);
    expect(types(menu(e, { qa: [qa(e, 'scope', [], 90)] }))).toEqual(['open_gate']);
  });

  it('never repeats a redraft from the same basis [REQ-26]', () => {
    const e = engagement();
    const ran: RedraftRecord = { subjectKey: 'scope', kind: 'delegate', basis: subjectInfo(e, 'scope')!.basis, sinceGateId: null };
    expect(menu(e, { redrafts: [ran] }).actions[0]).toMatchObject({ type: 'escalate' });
  });

  it('is a pure function of its input', () => {
    const { e, gates, qa: reviews } = planned();
    const given: GraphInput = { engagement: e, gates, qa: reviews, redrafts: [], qaThreshold: 70 };
    const copy = structuredClone(given);
    const a: Action[] = allowedActions(given).actions;
    expect(allowedActions(given).actions).toEqual(a);
    expect(given).toEqual(copy);
  });
});
