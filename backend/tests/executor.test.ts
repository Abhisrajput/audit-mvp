import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { addSpend, budgetProblem, lowerBudget } from '../src/agents/budget';
import { defaultAgentConfig, loadAgentConfig } from '../src/agents/config';
import { applyDecision, type ExecutorContext } from '../src/agents/executor';
import { listGates } from '../src/agents/gate-repo';
import { agentPort } from '../src/agents/port';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, leaseNext, listSteps } from '../src/agents/run-repo';
import { loadGraphInput, reconcileGates } from '../src/agents/state';
import { rootBasis } from '../src/agents/subjects';
import type { Action, QaReport } from '../src/agents/types';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
  // The executor writes only while its worker holds the run's lease, so lease the run the way a worker does.
  const run = (await leaseNext(svc.db.kysely, 'w1', 60_000))!;
  /** Applies one action the way the worker does, against the engagement as it is now. */
  const apply = async (action: Action, qa: QaReport | null = null) => {
    const ctx: ExecutorContext = {
      db: svc.db.kysely, port: agentPort(svc), run, starter: auditor, engagement: await svc.engagement(e.id),
      gates: await listGates(svc.db.kysely, e.id), menu: { stage: 'scope', actions: [action], qa, qaThreshold: 70 },
    };
    return applyDecision(ctx, { action, rationale: 'test', policy: 'rules', policyVersion: RULES_VERSION });
  };
  const steps = () => listSteps(svc.db.kysely, run.id);
  return { svc, e, run, apply, steps };
}

describe('the executor', () => {
  it('delegates through the agent port and records what the redraft was built from [REQ-28]', async () => {
    const { svc, e, run, apply, steps } = await setup();
    expect(await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' })).toEqual({ next: 'continue' });
    const [step] = await steps();
    expect(step).toMatchObject({ kind: 'delegate', agent: 'specialist:scope', decision: { action: { type: 'delegate', subjectKey: 'scope' }, basis: rootBasis(e), sinceGateId: null } });
    const bundle = (await readTrail(svc.db.kysely, e.id)).find((b) => b.id === step.trailBundleId)!;
    expect(bundle).toMatchObject({ moduleId: 'scope', actor: 'agent:scope', inputs: { runId: run.id, onBehalfOf: 'auditor' } });
  });

  it('records each QA review as a step and in the trail [REQ-28]', async () => {
    const { svc, e, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    const qa = (await steps()).at(-1)!;
    expect(qa).toMatchObject({ kind: 'qa', agent: 'qa', decision: { subjectKey: 'scope', reviewer: 'deterministic-1' } });
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === qa.trailBundleId)).toMatchObject({ moduleId: 'agent:qa', actor: 'agent:qa', output: qa.decision });
  });

  it('opens a gate with its QA report attached, then waits for the signature [REQ-27]', async () => {
    const { svc, e, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    const report = (await steps()).at(-1)!.decision as QaReport;
    expect(await apply({ type: 'open_gate', subjectKey: 'scope' }, report)).toEqual({ next: 'waiting', reason: 'awaiting scope gate signature' });
    expect(await listGates(svc.db.kysely, e.id)).toMatchObject([{ kind: 'scope', state: 'open', attempt: 1, qaReport: report }]);
    const opened = (await steps()).at(-1)!;
    expect(opened).toMatchObject({ kind: 'tool_call', agent: 'supervisor', decision: { tool: 'open_gate', kind: 'scope' } });
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === opened.trailBundleId)!.moduleId).toBe('agent:gate-open');
  });

  it('drafts test plans as the test-plan agent', async () => {
    const { svc, e, apply } = await setup();
    await svc.runModule(e.id, 'scope', auditor);
    await svc.runModule(e.id, 'rcm', auditor);
    await apply({ type: 'delegate', specialist: 'test-plan', subjectKey: 'test_plans' });
    const after = await svc.engagement(e.id);
    expect(Object.keys(after.testPlans).sort()).toEqual(after.rcm.map((r) => r.id).sort());
    expect((await readTrail(svc.db.kysely, e.id)).at(-1)).toMatchObject({ moduleId: 'agent:test-plans', actor: 'agent:test-plan' });
  });

  it('writes nothing once the worker has lost the run\'s lease', async () => {
    const { svc, run, apply, steps } = await setup();
    await sql`UPDATE agent_runs SET lease_owner = 'someone-else' WHERE id = ${run.id}`.execute(svc.db.kysely);
    await expect(apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' })).rejects.toMatchObject({ status: 409 });
    expect(await steps()).toEqual([]);
  });

  it('refuses to draft once the worker has lost the lease, leaving the engagement untouched', async () => {
    const { svc, e, run, apply, steps } = await setup();
    await sql`UPDATE agent_runs SET lease_owner = 'someone-else' WHERE id = ${run.id}`.execute(svc.db.kysely);
    const before = (await svc.engagement(e.id)).version;
    await expect(apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' })).rejects.toMatchObject({ status: 409 });
    expect(await steps()).toEqual([]);
    expect((await svc.engagement(e.id)).version).toBe(before);
  });

  it('records a rework as a delegate step', async () => {
    const { apply, steps } = await setup();
    await apply({ type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'tighten scope' });
    expect((await steps())[0]).toMatchObject({ kind: 'delegate', agent: 'specialist:scope', decision: { action: { type: 'rework' } } });
  });

  it('will not open a gate without a QA report for the subject as it is now', async () => {
    const { svc, e, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    const report = (await steps()).at(-1)!.decision as QaReport;
    await expect(apply({ type: 'open_gate', subjectKey: 'scope' }, { ...report, subjectHash: 'stale' })).rejects.toThrow(/no QA report/);
    await expect(apply({ type: 'open_gate', subjectKey: 'scope' }, null)).rejects.toThrow(/no QA report/);
    expect(await listGates(svc.db.kysely, e.id)).toEqual([]);
  });

  it("turns wait, escalate and complete into the run's next status", async () => {
    const { apply } = await setup();
    expect(await apply({ type: 'wait', reason: 'awaiting test results for 3 control(s)' })).toEqual({ next: 'waiting', reason: 'awaiting test results for 3 control(s)' });
    expect(await apply({ type: 'escalate', reason: 'gate_rejected_twice: scope' })).toEqual({ next: 'needs_human', reason: 'gate_rejected_twice: scope' });
    expect(await apply({ type: 'complete' })).toEqual({ next: 'completed' });
  });

  it('feeds QA reports and redrafts back to the graph, and supersedes a gate whose subject changed', async () => {
    const { svc, e, run, apply, steps } = await setup();
    await apply({ type: 'delegate', specialist: 'scope', subjectKey: 'scope' });
    await apply({ type: 'request_qa', subjectKey: 'scope', mode: 'review' });
    await apply({ type: 'open_gate', subjectKey: 'scope' }, (await steps()).at(-1)!.decision as QaReport);
    const now = await svc.engagement(e.id);
    const input = await loadGraphInput(svc.db.kysely, run, now, await listGates(svc.db.kysely, e.id), 70);
    expect(input.qa).toHaveLength(1);
    expect(input.redrafts).toEqual([{ subjectKey: 'scope', kind: 'delegate', basis: rootBasis(e), sinceGateId: null }]);
    expect(await reconcileGates(svc.db.kysely, now)).toBe(0);
    const first = now.scope[0];
    const edited = await svc.setScope(e.id, [{ controlId: first.controlId, included: !first.included }], auditor);
    expect(await reconcileGates(svc.db.kysely, edited)).toBe(1);
    expect((await listGates(svc.db.kysely, e.id))[0].state).toBe('superseded');
  });
});

describe('budgets [REQ-29]', () => {
  const budget = { maxSteps: 2, maxTokens: 100, maxCostUsd: 1 };
  const spent = { steps: 1, tokensIn: 40, tokensOut: 40, costUsd: 0.5 };

  it('stop a run before the step, tokens or cost it cannot afford', () => {
    expect(budgetProblem(budget, spent)).toBeNull();
    expect(budgetProblem(budget, { ...spent, steps: 2 })).toBe('budget_exhausted: 2 steps');
    expect(budgetProblem(budget, spent, { tokensIn: 30 })).toBe('budget_exhausted: 100 tokens');
    expect(budgetProblem(budget, spent, { costUsd: 0.6 })).toBe('budget_exhausted: $1');
    expect(addSpend(spent, { steps: 1, costUsd: 0.25 })).toEqual({ steps: 2, tokensIn: 40, tokensOut: 40, costUsd: 0.75 });
  });

  it('may be lowered by the starter, never raised', () => {
    const ceiling = defaultAgentConfig().budget;
    expect(lowerBudget(ceiling, { maxSteps: 20 })).toEqual({ ...ceiling, maxSteps: 20 });
    expect(() => lowerBudget(ceiling, { maxSteps: ceiling.maxSteps + 1 })).toThrow(/may not exceed/);
    expect(() => lowerBudget(ceiling, { maxCostUsd: 0 })).toThrow(/greater than 0/);
  });
});

describe('agent configuration [REQ-25]', () => {
  it('defaults to the spec’s values and validates overrides', () => {
    expect(defaultAgentConfig()).toEqual({
      enabled: true, budget: { maxSteps: 200, maxTokens: 2_000_000, maxCostUsd: 25 }, qaThreshold: 70, pollMs: 3000, concurrency: 2, leaseMs: 60_000, heartbeatMs: 15_000,
    });
    expect(loadAgentConfig({ AGENT_ENABLED: 'false' }).enabled).toBe(false);
    expect(() => loadAgentConfig({ AGENT_QA_THRESHOLD: '101' })).toThrow(/AGENT_QA_THRESHOLD/);
  });

  it('treats blank values as unset and rejects negative or garbage numbers', () => {
    expect(loadAgentConfig({ AGENT_ENABLED: '', AGENT_MAX_STEPS: '', AGENT_POLL_MS: '' })).toEqual(defaultAgentConfig());
    expect(() => loadAgentConfig({ AGENT_MAX_STEPS: '-5' })).toThrow(/AGENT_MAX_STEPS/);
    expect(() => loadAgentConfig({ AGENT_POLL_MS: 'soon' })).toThrow(/AGENT_POLL_MS/);
    expect(() => loadAgentConfig({ AGENT_WORKER_CONCURRENCY: '0' })).toThrow(/AGENT_WORKER_CONCURRENCY/);
  });
});
