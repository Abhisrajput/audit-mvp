import { describe, expect, it } from 'vitest';
import { RULES_VERSION, RulesPolicy, rulesChoice } from '../src/agents/policy/rules';
import { reviewSubject } from '../src/agents/qa/deterministic';
import { RUBRICS, subjectContent } from '../src/agents/qa/rubric';
import type { ReportOpinion } from '../src/engine/types';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { findingKey, rcmRowHash, subjectInfo } from '../src/agents/subjects';
import type { Action, Menu, QaIssue, QaReport } from '../src/agents/types';
import { engagement, finding, input, plan, result, row, scopeItem } from './agent-fixtures';
import { LENIENT, registry } from './helpers';

const issues = (r: QaReport) => r.issues.map((i) => [i.severity, i.criterion]);

describe('the offline QA reviewer', () => {
  it('blocks a scope with nothing in it, and flags high-risk controls left out', () => {
    const r = reviewSubject(engagement({ scope: [scopeItem('A', false, { inherentRisk: 'High' }), scopeItem('B', false)] }), 'scope');
    expect(issues(r)).toEqual([['blocking', 'scope.included'], ['advisory', 'scope.high-risk-excluded']]);
    expect(r.score).toBe(65);
  });

  it('blocks an assessed risk below the library, and a touched High area left out; flags unknown areas and a thin statement [REQ-30]', () => {
    const ctxt = { factors: [{ kind: 'incident' as const, processAreas: ['Lab', 'Warehouse'], description: 'OOS' }], background: '', updatedBy: 'u', updatedAt: 't' };
    const e = engagement({
      context: ctxt,
      scope: [scopeItem('A', false, { processArea: 'Lab', inherentRisk: 'Medium', assessedRisk: 'High' }), scopeItem('B', true, { processArea: 'QA', inherentRisk: 'High', assessedRisk: 'Medium' })],
      coverage: { excluded: [{ processArea: 'Lab', reason: 'below relevance threshold' }], statement: 'All good.' },
    });
    const r = reviewSubject(e, 'scope', undefined, new Set(['Lab', 'QA']));
    expect(issues(r)).toEqual(expect.arrayContaining([
      ['blocking', 'scope.assessed-below-library'], ['blocking', 'scope.touched-high-excluded'],
      ['advisory', 'scope.factor-unknown-area'], ['advisory', 'scope.coverage-statement'],
    ]));
    expect(issues(r)).not.toContainEqual(['blocking', 'scope.high-risk-excluded']);   // today's check stays advisory
  });

  it('raises nothing new for a scope with no context, so the golden-trace engagements are unchanged', () => {
    const r = reviewSubject(engagement({ scope: [scopeItem('A', true), scopeItem('B', false, { inherentRisk: 'High' })] }), 'scope');
    expect(issues(r)).toEqual([['advisory', 'scope.high-risk-excluded']]);
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
  const menu = (actions: Action[], report: QaReport | null): Menu => ({ stage: 'scope', actions, qa: report, qaThreshold: 70, memo: null });
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
      sampleSize: 25, selectionMethod: 'random', recommendedToleranceRate: 0.05, evidenceToRequest: ['Batch record', 'Line clearance log'], procedure: 'Select batches\nInspect sign-off',
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

describe('scope items stored before the risk assessment existed', () => {
  it('are reviewed without error, and their missing assessed risk is not read as below the library', () => {
    const old = scopeItem('OLD', true, { inherentRisk: 'High' }) as Partial<ReturnType<typeof scopeItem>>;
    delete old.assessedRisk;
    delete old.riskFactors;
    const e = engagement({ scope: [old as ReturnType<typeof scopeItem>] });
    const report = reviewSubject(e, 'scope');
    expect(report.issues.map((i) => i.criterion)).not.toContain('scope.assessed-below-library');
    expect(() => JSON.stringify(subjectContent(e, 'scope'))).not.toThrow();
  });
});

describe('the finding judgment checks (spec §5.5) [REQ-32]', () => {
  const key = findingKey('A');
  const withResult = (over: object) => ({ ...result('A'), ...over });
  const withInput = (observation: string) => ({ ...input(), observation });

  it('blocks a rating that is not the matrix cell, and a confirmed cause the observation does not support; flags a severity of none beside negative wording', () => {
    const mismatch = engagement({ rcm: [row('A')], findings: [finding('A', 'draft', { likelihood: 'rare', impact: 'minor', rating: 'High' })] });
    expect(issues(reviewSubject(mismatch, key))).toContainEqual(['blocking', 'finding.rating-matrix']);

    const unsupported = engagement({
      rcm: [row('A')], testInputs: { A: withInput('Checks missed in March') },
      findings: [finding('A', 'draft', { rootCause: { category: 'people', analysis: 'Understaffing across departments', confirmed: true } })],
    });
    expect(issues(reviewSubject(unsupported, key))).toContainEqual(['blocking', 'finding.root-cause-unsupported']);

    const none = engagement({ rcm: [row('A')], testInputs: { A: withInput('Two records missing from the log') }, testResults: { A: withResult({ severity: 'none' }) }, findings: [finding('A')] });
    expect(issues(reviewSubject(none, key))).toContainEqual(['advisory', 'finding.severity-signal']);
  });

  it('flags a confirmed cause paired with the library recommendation unchanged (needs the registry)', () => {
    const library = registry.controls.get('FD-HACCP-03')!.recommendation;
    const e = engagement({
      rcm: [row('FD-HACCP-03')], testInputs: { 'FD-HACCP-03': withInput('Checks missed while staffing was short') },
      findings: [finding('FD-HACCP-03', 'draft', { recommendation: library, rootCause: { category: 'people', analysis: 'Staffing was short that week', confirmed: true } })],
    });
    const checks = { registry, policy: LENIENT.citationPolicy };
    expect(issues(reviewSubject(e, findingKey('FD-HACCP-03'), checks))).toContainEqual(['advisory', 'finding.recommendation-verbatim']);
    expect(issues(reviewSubject(e, findingKey('FD-HACCP-03')))).not.toContainEqual(['advisory', 'finding.recommendation-verbatim']);
  });
});

describe('the report opinion and responses in the offline QA review', () => {
  it('blocks a report whose opinion is better than the rule and nobody set it, notes a CAE-set opinion with the rule beside it, and is silent on a report without an opinion [REQ-30, REQ-32]', () => {
    const approved = [finding('a', 'approved', { id: 'F1', rating: 'High' })];
    const report = (opinion?: ReportOpinion) => ({ generatedAt: 't', bundleId: 'b', markdown: '# r', includedFindingIds: ['F1'], excludedFindingIds: [], ...(opinion ? { opinion } : {}) });
    const e = engagement({ findings: approved, report: report() });
    expect(reviewSubject(e, 'report').issues.map((i) => i.criterion)).not.toContain('report.opinion-rule');
    const better = engagement({ findings: approved, report: report({ rating: 'satisfactory', basis: 'b', findingsFingerprint: 'x' }) });
    expect(reviewSubject(better, 'report').issues).toContainEqual(expect.objectContaining({ criterion: 'report.opinion-rule', severity: 'blocking' }));
    const cae = engagement({ findings: approved, report: report({ rating: 'satisfactory', basis: 'b', setBy: 'SIG-1', findingsFingerprint: 'x' }) });
    const r = reviewSubject(cae, 'report');
    expect(r.issues.map((i) => i.criterion)).not.toContain('report.opinion-rule');
    expect(r.issues).toContainEqual(expect.objectContaining({ criterion: 'report.opinion-set-by-cae', severity: 'advisory', detail: expect.stringContaining('unsatisfactory') }));
  });

  it('notes an approved finding whose response is missing from the report markdown, and nothing when no response exists', () => {
    const approved = [finding('a', 'approved', { id: 'F1', rating: 'Low' })];
    const response = { id: 'R1', findingId: 'F1', response: 'agree' as const, owner: 'Plant manager', dueDate: null, actionPlan: 'Fix', recordedBy: 'auditor', recordedAt: 't', trailBundleId: 'HUM-1' };
    const silent = engagement({ findings: approved, report: { generatedAt: 't', bundleId: 'b', markdown: '# r', includedFindingIds: ['F1'], excludedFindingIds: [] } });
    expect(reviewSubject(silent, 'report').issues.map((i) => i.criterion)).not.toContain('report.responses');
    const stale = engagement({ findings: approved, responses: { F1: response }, report: { generatedAt: 't', bundleId: 'b', markdown: '# r', includedFindingIds: ['F1'], excludedFindingIds: [] } });
    expect(reviewSubject(stale, 'report').issues).toContainEqual(expect.objectContaining({ criterion: 'report.responses', severity: 'advisory' }));
    const fresh = { ...stale, report: { ...stale.report!, markdown: '# r\n- **Management response:** Agree — owner Plant manager' } };
    expect(reviewSubject(fresh, 'report').issues.map((i) => i.criterion)).not.toContain('report.responses');
  });

  it('the report rubric asks whether the opinion follows from the findings, citing IIA 14.5', () => {
    expect(RUBRICS.report).toContainEqual({ id: 'report.opinion-basis', question: expect.any(String), standard: 'IIA-14.5' });
    expect(subjectContent(engagement({ report: null }), 'report')).toEqual({ markdown: null, opinion: null, memo: null });
  });
});
