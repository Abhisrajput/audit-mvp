import { describe, expect, it } from 'vitest';
import {
  actionLabel, belowThreshold, budgetProblem, changedEngagement, currentRun, describeStep, explainStatus, fallbackOf, gateSigning, loadStepsSince,
  findingContentHash, openFindingGate, planDraft, planPatch, pollDelayMs, reviewIsCurrent, rowsAwaitingTests, sortGates, spendRows, STEP_PAGE, subjectLabel,
} from './agents';
import type { AgentRun, AgentStep, Decision, Engagement, Finding, Gate, QaReport, TestPlan, User } from './types';

const RUN: AgentRun = {
  id: 'AR-1', engagementId: 'ENG-1', goal: 'engagement', status: 'running', statusReason: '', policy: 'rules', policyVersion: 'rules-1',
  budget: { maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 25 }, spent: { steps: 50, tokensIn: 150_000, tokensOut: 50_000, costUsd: 24 },
  startedBy: 'auditor', cancelRequested: false, pauseRequested: false, wakeRequested: false, failureStreak: 0, conflictStreak: 0, wakeAt: null,
  leaseOwner: null, leaseUntil: null, version: 3, createdAt: '2026-10-14T09:00:00.000Z', updatedAt: '2026-10-14T09:05:00.000Z', endedAt: null,
};
const run = (over: Partial<AgentRun> = {}): AgentRun => ({ ...RUN, ...over });
const step = (over: Partial<AgentStep> = {}): AgentStep => ({
  runId: 'AR-1', seq: 1, kind: 'decision', agent: 'supervisor', decision: {}, model: null, tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0,
  trailBundleId: null, createdAt: '2026-10-14T09:00:00.000Z', ...over,
});
const REPORT: QaReport = { subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 'deterministic-2', score: 62, issues: [{ criterion: 'coverage', severity: 'advisory', detail: 'Two risks lack a control' }] };
const gate = (over: Partial<Gate> = {}): Gate => ({
  id: 'GATE-1', engagementId: 'ENG-1', runId: 'AR-1', kind: 'scope', subjectKey: 'scope', subjectId: 'scope', subjectHash: 'h', basisHash: 'b',
  state: 'open', attempt: 1, comment: '', signatureId: null, qaReport: REPORT, openedAt: '2026-10-14T09:10:00.000Z', closedAt: null, ...over,
});
const manager: User = { id: 'reviewer', name: 'Rita Reviewer', role: 'audit_manager' };
const cae: User = { id: 'approver', name: 'Ann Approver', role: 'cae' };
const decision = (over: Partial<Decision>): Decision => ({ action: { type: 'complete' }, rationale: '', policy: 'rules', policyVersion: 'rules-1', ...over });
const PLAN: TestPlan = {
  rowId: 'FD-HACCP-03', rowHash: 'rh', attribute: 'CCP log signed', population: 'CCP logs, Jan-Jun', sampleSize: 25, selectionMethod: 'random',
  evidenceToRequest: ['CCP log', 'Calibration record'], procedure: 'Inspect each log for a signature.',
};

describe('which run to show, and how often to look again', () => {
  it('shows the live run, else the latest, and polls by status', () => {
    expect(currentRun([run({ id: 'AR-3', status: 'completed' }), run({ id: 'AR-2', status: 'waiting' })])?.id).toBe('AR-2');
    expect(currentRun([run({ id: 'AR-3', status: 'completed' }), run({ id: 'AR-1', status: 'cancelled' })])?.id).toBe('AR-3');
    expect(currentRun([])).toBeNull();
    expect(pollDelayMs(run({ status: 'running' }), false)).toBe(3000);
    expect(pollDelayMs(run({ status: 'runnable' }), false)).toBe(3000);
    expect(pollDelayMs(run({ status: 'waiting' }), false)).toBe(15000);
    expect(pollDelayMs(run({ status: 'needs_human' }), true)).toBe(15000);
    expect(pollDelayMs(run({ status: 'completed' }), true)).toBe(15000);
    expect(pollDelayMs(run({ status: 'failed' }), false)).toBeNull();
    expect(pollDelayMs(null, false)).toBe(15000);
  });
});

describe('the run status in plain words', () => {
  it('says why the run stopped and what a person can do', () => {
    expect(explainStatus(run({ status: 'waiting', statusReason: 'awaiting test results for 3 control(s)' }))).toEqual({
      text: 'Waiting for field work: test results for 3 control(s).',
      next: 'Record each test in Fieldwork & testing, or give a reason not to test it in Test plans. The run moves on by itself.',
    });
    expect(explainStatus(run({ status: 'waiting', statusReason: 'awaiting scope gate signature' })).next).toMatch(/approves or rejects the open gate/);
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'budget_exhausted: $25' }))).toEqual({
      text: 'The run used its budget ($25).', next: 'An audit manager can raise the budget; the run then resumes.',
    });
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'gate_rejected_twice: finding:FD-HACCP-03' })).text).toBe('A gate was rejected twice (finding for FD-HACCP-03).');
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'agent_forbidden: An agent may not sign' })).text).toBe('The rails refused an action: An agent may not sign');
    expect(explainStatus(run({ status: 'waiting', statusReason: 'paused_by_user' }))).toEqual({ text: 'Paused.', next: 'Resume the run when you are ready.' });
    expect(explainStatus(run({ status: 'needs_human', statusReason: 'something new' }))).toEqual({ text: 'something new', next: 'Fix what it asks for, then resume.' });
  });
});

describe('spend against budget', () => {
  it('shows iterations, tokens and cost with how full each is', () => {
    expect(spendRows(RUN)).toEqual([
      { label: 'Iterations', used: '50', limit: '200', pct: 25 },
      { label: 'Model tokens', used: '200,000', limit: '2,000,000', pct: 10 },
      { label: 'Model cost', used: '$24.00', limit: '$25.00', pct: 96 },
    ]);
    expect(spendRows(run({ spent: { steps: 300, tokensIn: 0, tokensOut: 0, costUsd: 0 } }))[0].pct).toBe(100);
  });
});

describe('the step timeline', () => {
  it('names subjects and actions in words', () => {
    expect(subjectLabel('rcm')).toBe('RCM');
    expect(subjectLabel('finding:FD-HACCP-03')).toBe('finding for FD-HACCP-03');
    expect(actionLabel({ type: 'delegate', specialist: 'gaps', subjectKey: 'gaps', rows: ['R1', 'R2'] })).toBe('Draft the findings (R1, R2)');
    expect(actionLabel({ type: 'request_qa', subjectKey: 'scope', mode: 'challenge' })).toBe('Challenge the scope');
    expect(actionLabel({ type: 'escalate', reason: 'QA found 2 issue(s)' })).toBe('Hand over to a person: QA found 2 issue(s)');
  });

  it('shows who chose each decision, and when the rules took over from the model', () => {
    const fallback = decision({ attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 3' }, { outcome: 'off_menu', model: null, detail: 'not on the menu' }] });
    expect(fallbackOf(fallback)).toBe('the model chose an action that is not allowed');
    expect(fallbackOf(decision({ attempts: [{ outcome: 'model_error', model: null, detail: 'overloaded' }] }))).toBe('the model was unavailable');
    expect(fallbackOf(decision({}))).toBeNull();
    expect(fallbackOf(decision({ policy: 'llm', attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 0' }] }))).toBeNull();
    expect(describeStep(step({ decision: decision({ action: { type: 'open_gate', subjectKey: 'scope' }, rationale: 'QA passed', policy: 'llm' }) }))).toMatchObject({
      title: 'Open the scope gate', detail: 'QA passed', policy: 'llm', fallback: null,
    });
  });

  it('describes delegations, QA reviews and tool calls from their records', () => {
    expect(describeStep(step({ kind: 'delegate', agent: 'specialist:scope', decision: {
      action: { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'Add the allergen controls' }, basis: 'b', sinceGateId: null, bundleId: 'RUN-1', withoutModel: true,
    } }))).toMatchObject({ title: 'Redrafted the scope (scope specialist)', detail: 'Instruction: Add the allergen controls', withoutModel: true });
    expect(describeStep(step({ kind: 'qa', agent: 'qa', decision: { ...REPORT, issues: [...REPORT.issues, { criterion: 'citations', severity: 'blocking', detail: 'x' }] } }))).toMatchObject({
      title: 'QA review of the scope: 62/100', detail: '2 issue(s), 1 blocking',
    });
    expect(describeStep(step({ kind: 'tool_call', decision: { tool: 'open_gate', gateId: 'GATE-2', kind: 'rcm', attempt: 2 } })).title).toBe('Opened the rcm gate (attempt 2)');
    expect(describeStep(step({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } }))).toMatchObject({ title: 'Refused by the rails', detail: 'An agent may not sign', refused: true });
    expect(describeStep(step({ kind: 'tool_call', agent: 'qa', decision: { tool: 'search_knowledge', args: {}, resultIds: ['a', 'b'] } }))).toMatchObject({
      title: 'Looked up the knowledge base (search_knowledge)', detail: '2 result(s)', refused: false,
    });
    expect(describeStep(step({ kind: 'tool_call', agent: 'worker', decision: { recovered: 'The worker stopped mid-step.' } })).title).toBe('Took over from a worker that stopped mid-step');
  });

  it('loads every step after the last one seen, page by page', async () => {
    const all = Array.from({ length: 1203 }, (_, i) => step({ seq: i + 1 }));
    const asked: number[] = [];
    const page = async (after: number) => {
      asked.push(after);
      return all.filter((s) => s.seq > after).slice(0, STEP_PAGE);
    };
    expect((await loadStepsSince(page, 0)).map((s) => s.seq)).toEqual(all.map((s) => s.seq));
    expect(asked).toEqual([0, 500, 1000]);
    expect(await loadStepsSince(page, 1203)).toEqual([]);
  });

  it('reloads the engagement only when the agent drafted something', () => {
    expect(changedEngagement([step({ kind: 'decision' }), step({ kind: 'qa' })])).toBe(false);
    expect(changedEngagement([step({ kind: 'decision' }), step({ kind: 'delegate' })])).toBe(true);
  });
});

describe('gates', () => {
  it('lists open gates first, decided ones newest first, and only counts superseded ones', () => {
    const sorted = sortGates([gate({ id: 'G1', state: 'superseded' }), gate({ id: 'G2', state: 'rejected' }), gate({ id: 'G3', state: 'approved' }), gate({ id: 'G4' })]);
    expect(sorted).toMatchObject({ open: [{ id: 'G4' }], decided: [{ id: 'G3' }, { id: 'G2' }], superseded: 1 });
  });

  it('lets only the right signer, who did not start the run, sign a workpaper gate', () => {
    expect(gateSigning(gate(), manager, [RUN])).toMatchObject({ canSign: true });
    expect(gateSigning(gate(), cae, [RUN])).toEqual({ canSign: false, note: 'Awaiting signature by an audit manager.' });
    expect(gateSigning(gate({ kind: 'report', subjectKey: 'report' }), cae, [RUN])).toMatchObject({ canSign: true });
    expect(gateSigning(gate(), manager, [run({ startedBy: 'reviewer' })])).toEqual({ canSign: false, note: 'You started this run, so someone else must sign its gates.' });
    expect(gateSigning(gate(), manager, [run({ status: 'cancelled' })]).canSign).toBe(false);
    expect(gateSigning(gate({ kind: 'finding', subjectKey: 'finding:R1', subjectId: 'F-1' }), cae, [RUN])).toMatchObject({ canSign: false, note: expect.stringMatching(/Findings tab/) });
    expect(gateSigning(gate({ state: 'approved' }), manager, [RUN])).toEqual({ canSign: false, note: 'This gate is approved.' });
  });

  it("finds a finding's open gate, and flags a report scored below the threshold", () => {
    const gates = [gate({ id: 'G1', kind: 'finding', subjectId: 'F-1', state: 'superseded' }), gate({ id: 'G2', kind: 'finding', subjectId: 'F-1' })];
    expect(openFindingGate(gates, 'F-1')?.id).toBe('G2');
    expect(openFindingGate(gates, 'F-2')).toBeNull();
    expect(belowThreshold(REPORT, 70)).toBe(true);
    expect(belowThreshold(REPORT, 60)).toBe(false);
    expect(belowThreshold(null, 70)).toBe(false);
  });
});

describe('forms', () => {
  it('checks a budget a person typed', () => {
    const ceiling = RUN.budget;
    expect(budgetProblem({ maxSteps: 100, maxTokens: 500_000, maxCostUsd: 5 }, { max: ceiling })).toBeNull();
    expect(budgetProblem({ maxSteps: Number(''), maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations must be a positive whole number');
    expect(budgetProblem({ maxSteps: 2.5, maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations must be a positive whole number');
    expect(budgetProblem({ maxSteps: 10, maxTokens: 1, maxCostUsd: -1 }, { max: ceiling })).toBe('Model cost (USD) must be a positive number');
    expect(budgetProblem({ maxSteps: 201, maxTokens: 1, maxCostUsd: 1 }, { max: ceiling })).toBe('Iterations may not exceed 200');
    expect(budgetProblem({ maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 20 }, { min: ceiling })).toBe('Model cost (USD) can only be raised (it is 25)');
  });

  it('turns a test-plan form into the changes to send', () => {
    expect(planPatch(PLAN, planDraft(PLAN))).toEqual({ patch: {} });
    expect(planPatch(PLAN, { ...planDraft(PLAN), sampleSize: '30', evidenceToRequest: 'CCP log\n\n  Thermometer log  ' })).toEqual({
      patch: { sampleSize: 30, evidenceToRequest: ['CCP log', 'Thermometer log'] },
    });
    expect(planPatch(PLAN, { ...planDraft(PLAN), notTestedJustification: '   ' })).toEqual({ patch: {} });
    expect(planPatch({ ...PLAN, notTestedJustification: 'Retired' }, { ...planDraft(PLAN), notTestedJustification: ' ' })).toEqual({ patch: { notTestedJustification: '' } });
    expect(planPatch(PLAN, { ...planDraft(PLAN), sampleSize: '-1' })).toEqual({ problem: 'Sample size must be a whole number, 0 or more' });
    expect(planPatch(PLAN, { ...planDraft(PLAN), procedure: ' ' })).toEqual({ problem: 'Procedure cannot be empty' });
  });

  it('counts the controls a run still waits on, as the run does', () => {
    const e = {
      rcm: [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }],
      testInputs: { R1: {} },
      testPlans: { R2: { notTestedJustification: '   ' }, R3: { notTestedJustification: 'Control retired in March' } },
    } as unknown as Engagement;
    expect(rowsAwaitingTests(e)).toEqual(['R2']);
  });
});

describe('finding review currency', () => {
  const finding = {
    id: 'F-1', rowId: 'R-1', controlId: 'C-1', title: 't', rating: 'High', condition: 'c', criteria: 'k', cause: 'x', effect: 'e', recommendation: 'r',
    citations: [{ id: 'P1' }], evidenceRefs: ['E1'], status: 'draft', blockedReasons: [], signOffs: [], bundleId: 'B',
  } as unknown as Finding;
  it('hashes a finding exactly as the server does, ignoring status and sign-offs', async () => {
    const { findingContentHash: server } = await import('../../backend/src/signing/content-hash');
    expect(await findingContentHash(finding)).toBe(server(finding as never));
    expect(await findingContentHash({ ...finding, status: 'approved' } as Finding)).toBe(await findingContentHash(finding));
    expect(await findingContentHash({ ...finding, condition: 'changed' })).not.toBe(await findingContentHash(finding));
  });
  it('trusts a review only while its hash matches the finding', () => {
    expect(reviewIsCurrent(gate({ subjectHash: 'h' }), 'h')).toBe(true);
    expect(reviewIsCurrent(gate({ subjectHash: 'h' }), 'other')).toBe(false);
    expect(reviewIsCurrent(gate({ subjectHash: 'h' }), null)).toBe(false);
  });
});
