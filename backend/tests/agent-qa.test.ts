import { describe, expect, it } from 'vitest';
import { RULES_VERSION, RulesPolicy, rulesChoice } from '../src/agents/policy/rules';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { findingKey, rcmRowHash, subjectInfo } from '../src/agents/subjects';
import type { Action, Menu, QaIssue, QaReport } from '../src/agents/types';
import { engagement, finding, plan, row, scopeItem } from './agent-fixtures';

const issues = (r: QaReport) => r.issues.map((i) => [i.severity, i.criterion]);

describe('the offline QA reviewer', () => {
  it('blocks a scope with nothing in it, and flags high-risk controls left out', () => {
    const r = reviewSubject(engagement({ scope: [scopeItem('A', false, { inherentRisk: 'High' }), scopeItem('B', false)] }), 'scope');
    expect(issues(r)).toEqual([['blocking', 'scope.included'], ['advisory', 'scope.high-risk-excluded']]);
    expect(r.score).toBe(65);
  });

  it('blocks RCM rows that cite no clause', () => {
    const r = reviewSubject(engagement({ rcm: [row('A'), row('B', { citations: [] })] }), 'rcm');
    expect(issues(r)).toEqual([['blocking', 'rcm.citations']]);
  });

  it('blocks a missing test plan and flags thin ones', () => {
    const a = row('A', { sampleSize: 5 });
    const e = engagement({ rcm: [a, row('B')], testPlans: { A: plan(a, { sampleSize: 2, evidenceToRequest: [] }) } });
    expect(issues(reviewSubject(e, 'test_plans'))).toEqual([['advisory', 'plans.evidence'], ['advisory', 'plans.sample'], ['blocking', 'plans.coverage']]);
  });

  it('blocks a finding the QA gates blocked, or one missing a C, a citation or evidence', () => {
    const f = finding('A', 'blocked', { blockedReasons: ['Cites a clause outside the grounding set'], cause: ' ', evidenceRefs: [] });
    const r = reviewSubject(engagement({ rcm: [row('A')], findings: [f] }), findingKey('A'));
    expect(issues(r)).toEqual([['blocking', 'finding.blocked'], ['blocking', 'finding.five-cs'], ['blocking', 'finding.evidence']]);
    expect(r.score).toBe(25);
  });

  it('blocks a report that leaves out an approved finding', () => {
    const e = engagement({
      findings: [finding('A', 'approved')],
      report: { generatedAt: 't', bundleId: 'RUN-1', markdown: '# R', includedFindingIds: [], excludedFindingIds: ['F-B'] },
    });
    expect(issues(reviewSubject(e, 'report'))).toEqual([['blocking', 'report.coverage'], ['advisory', 'report.excluded']]);
    expect(issues(reviewSubject(engagement(), 'report'))).toEqual([['blocking', 'report.missing']]);
  });

  it('caps what advisory issues cost, so on their own they never force a redraft', () => {
    const scope = ['A', 'B', 'C', 'D', 'E'].map((id) => scopeItem(id, false, { inherentRisk: 'High' }));
    const r = reviewSubject(engagement({ scope: [scopeItem('Z'), ...scope] }), 'scope');
    expect(r.issues).toHaveLength(5);
    expect(r.score).toBe(70);
  });

  it('reviews exactly the content the graph sees', () => {
    const e = engagement({ scope: [scopeItem('A')] });
    expect(reviewSubject(e, 'scope')).toMatchObject({ subjectKey: 'scope', subjectHash: subjectInfo(e, 'scope')!.hash, mode: 'review', reviewer: 'deterministic-1' });
    expect(() => reviewSubject(e, 'finding:NOPE')).toThrow(/Nothing to review/);
  });
});

describe('the rules policy', () => {
  const gate: Action = { type: 'open_gate', subjectKey: 'scope' };
  const redo: Action = { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'fix it' };
  const escalate: Action = { type: 'escalate', reason: 'QA found issues' };
  const qa = (score: number, list: QaIssue[]): QaReport => ({ subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 't', score, issues: list });
  const menu = (actions: Action[], report: QaReport | null): Menu => ({ stage: 'scope', actions, qa: report, qaThreshold: 70 });
  const block: QaIssue = { criterion: 'x', severity: 'blocking', detail: 'd' };
  const note: QaIssue = { criterion: 'y', severity: 'advisory', detail: 'd' };

  it('redrafts blocking issues while it can, then escalates [REQ-26]', () => {
    expect(rulesChoice(menu([redo, escalate], qa(75, [block]))).action).toEqual(redo);
    expect(rulesChoice(menu([escalate], qa(75, [block]))).action).toEqual(escalate);
  });

  it('redrafts a low score while it can, then lets the signer decide [REQ-26]', () => {
    expect(rulesChoice(menu([gate, redo, escalate], qa(60, [note]))).action).toEqual(redo);
    expect(rulesChoice(menu([gate, escalate], qa(60, [note]))).action).toEqual(gate);
    expect(rulesChoice(menu([gate, redo, escalate], qa(80, [note]))).action).toEqual(gate);
  });

  it('takes the first action when there is no QA to weigh', () => {
    expect(rulesChoice(menu([escalate, gate], null)).action).toEqual(escalate);
  });

  it('returns a typed decision under its own version', async () => {
    const d = await new RulesPolicy().decide(menu([gate, redo, escalate], qa(80, [note])));
    expect(d).toMatchObject({ action: gate, policy: 'rules', policyVersion: RULES_VERSION });
    expect(d.rationale.length).toBeLessThanOrEqual(500);
  });
});

describe('the test-plan drafter', () => {
  it('drafts a plan for each RCM row from what the RCM says', () => {
    const a = row('A', { sampleSize: 25, evidenceExpected: ['Batch record', 'Line clearance log'], testOfEffectiveness: ['Select batches', 'Inspect sign-off'] });
    const yearly = row('B', { frequency: 'Annual', sampleSize: 1 });
    const plans = draftTestPlans(engagement({ rcm: [a, yearly] }));
    expect(plans.A).toEqual({
      rowId: 'A', rowHash: rcmRowHash(a), attribute: 'Objective A',
      population: 'Every performance of "Control A" (monthly) from 2026-01-01 to 2026-06-30',
      sampleSize: 25, selectionMethod: 'random', evidenceToRequest: ['Batch record', 'Line clearance log'], procedure: 'Select batches\nInspect sign-off',
    });
    expect(plans.B.selectionMethod).toBe('all');
  });

  it("keeps a plan whose row is unchanged, keeps a person's reason not to test, and drops plans for rows that are gone [REQ-27]", () => {
    const a = row('A');
    const edited = plan(a, { attribute: 'Edited by the auditor', editedBy: 'auditor', editedAt: 't' });
    const b = row('B');
    const skipped = plan(b, { rowHash: 'old', notTestedJustification: 'Retired in March', editedBy: 'auditor', editedAt: 't' });
    const plans = draftTestPlans(engagement({ rcm: [a, b], testPlans: { A: edited, B: skipped, GONE: plan(row('GONE')) } }));
    expect(plans.A).toBe(edited);
    expect(plans.B).toMatchObject({ rowHash: rcmRowHash(b), notTestedJustification: 'Retired in March', editedBy: 'auditor' });
    expect(Object.keys(plans)).toEqual(['A', 'B']);
  });
});
