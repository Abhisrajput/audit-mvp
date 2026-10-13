import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { observeSteps } from '../src/agents/metrics';
import { listSteps, type AgentStep } from '../src/agents/run-repo';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { ensureDevUsers } from '../src/auth/dev-users';
import { AppError } from '../src/errors';
import { registry } from '../src/observability/metrics';
import { auditor, FakeProvider, NEW_ENGAGEMENT, newService, noWait, TEST_LLM } from './helpers';

/** A metric's current value for the given labels; for a histogram, how many observations it has. */
async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)!.get();
  const wanted = String(metric.type) === 'histogram' ? `${name}_count` : name;
  const match = metric.values.find((v) => (v.metricName ?? name) === wanted && Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

const step = (over: Partial<AgentStep>): AgentStep => ({
  runId: 'AR-test', seq: 1, kind: 'decision', agent: 'supervisor', decision: {}, model: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
  durationMs: 0, trailBundleId: null, createdAt: new Date(0).toISOString(), ...over,
});

async function startedRun(llm: FakeProvider | null = null) {
  const svc = await newService(llm);
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const cfg = llm ? { ...defaultAgentConfig(), llm: TEST_LLM } : defaultAgentConfig();
  const { run } = await startRun(svc, cfg, e.id, auditor);
  return { svc, db: svc.db.kysely, run, cfg };
}

describe('agent metrics', () => {
  it('count step durations by kind, and tokens and cost by agent and model', async () => {
    const before = {
      qa: await metricValue('audit_agent_step_duration_seconds', { kind: 'qa' }),
      tokensIn: await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'input' }),
      tokensOut: await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'output' }),
      cost: await metricValue('audit_agent_cost_usd_total', { agent: 'qa', model: 'm-metrics' }),
    };
    observeSteps([
      step({ kind: 'qa', agent: 'qa', model: 'm-metrics', tokensIn: 1200, tokensOut: 300, costUsd: 0.25, durationMs: 4200 }),
      step({ kind: 'qa', agent: 'qa', model: 'm-metrics', tokensIn: 800, tokensOut: 100, costUsd: 0.05, durationMs: 900 }),
    ]);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'qa' })).toBe(before.qa + 2);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'input' })).toBe(before.tokensIn + 2000);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'qa', model: 'm-metrics', kind: 'output' })).toBe(before.tokensOut + 400);
    expect(await metricValue('audit_agent_cost_usd_total', { agent: 'qa', model: 'm-metrics' })).toBeCloseTo(before.cost + 0.3, 6);
  });

  it('count a decision the rules took over from the model, by the model attempt that failed', async () => {
    const malformed = await metricValue('audit_agent_policy_fallbacks_total', { reason: 'malformed' });
    const offMenu = await metricValue('audit_agent_policy_fallbacks_total', { reason: 'off_menu' });
    const complete = { type: 'complete' };
    observeSteps([
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1', attempts: [
        { outcome: 'malformed', model: null, detail: 'x' }, { outcome: 'malformed', model: null, detail: 'y' },
      ] } }),
      // The worker's last line of defence: the model chose, but off the menu.
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1', attempts: [
        { outcome: 'chosen', model: 'm', detail: 'chose 3' }, { outcome: 'off_menu', model: null, detail: 'not on the menu' },
      ] } }),
      // Rules on an offline run, and the model's own choice, are not fallbacks.
      step({ decision: { action: complete, rationale: 'r', policy: 'rules', policyVersion: 'rules-1' } }),
      step({ decision: { action: complete, rationale: 'r', policy: 'llm', policyVersion: 'llm-1', attempts: [{ outcome: 'chosen', model: 'm', detail: 'chose 0' }] } }),
    ]);
    expect(await metricValue('audit_agent_policy_fallbacks_total', { reason: 'malformed' })).toBe(malformed + 1);
    expect(await metricValue('audit_agent_policy_fallbacks_total', { reason: 'off_menu' })).toBe(offMenu + 1);
  });

  it('count refusals by the rails apart from refused model lookups', async () => {
    const rails = await metricValue('audit_agent_guard_refusals_total', { source: 'rails' });
    const lookups = await metricValue('audit_agent_guard_refusals_total', { source: 'model_request' });
    const toolSeconds = await metricValue('audit_agent_step_duration_seconds', { kind: 'tool_call' });
    const absurd = 'x'.repeat(100);
    observeSteps([
      step({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } }),
      step({ kind: 'tool_call', agent: 'qa', decision: { tool: absurd, args: '{}', resultIds: [], refused: `${absurd} is not on the qa agent's allow-list` } }),
      step({ kind: 'tool_call', agent: 'qa', decision: { tool: 'search_knowledge', args: { query: 'allergen' }, resultIds: ['n1'] }, durationMs: 40 }),
    ]);
    // A refused step took no time (0 ms) and adds no duration observation; the one real lookup adds one.
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'tool_call' })).toBe(toolSeconds + 1);
    expect(await metricValue('audit_agent_guard_refusals_total', { source: 'rails' })).toBe(rails + 1);
    expect(await metricValue('audit_agent_guard_refusals_total', { source: 'model_request' })).toBe(lookups + 1);
    // A name a model made up never becomes a label.
    expect(await registry.metrics()).not.toContain(absurd);
  });

  it('are counted by the worker for each step it commits', async () => {
    const { svc, db, run, cfg } = await startedRun(new FakeProvider(() => ({ items: [] })));
    const before = {
      decisions: await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' }),
      delegates: await metricValue('audit_agent_step_duration_seconds', { kind: 'delegate' }),
      tokens: await metricValue('audit_agent_tokens_total', { agent: 'specialist:scope', model: 'fake-1', kind: 'input' }),
    };
    await new AgentWorker(svc, cfg, { id: 'w-metrics', wait: noWait }).tick();
    const [, delegate] = await listSteps(db, run.id);
    expect(delegate).toMatchObject({ kind: 'delegate', agent: 'specialist:scope', model: 'fake-1' });
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' })).toBe(before.decisions + 1);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'delegate' })).toBe(before.delegates + 1);
    expect(await metricValue('audit_agent_tokens_total', { agent: 'specialist:scope', model: 'fake-1', kind: 'input' })).toBe(before.tokens + delegate.tokensIn);
  });

  it('counts nothing from an iteration whose worker lost the run before handing it back', async () => {
    const { svc, db, run, cfg } = await startedRun();
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementation(async () => {
      // Another worker takes the run while the specialist works.
      await sql`UPDATE agent_runs SET lease_owner = 'w-other' WHERE id = ${run.id}`.execute(db);
      throw new AppError(409, `Agent run ${run.id} is no longer held by this worker`, 'LEASE_LOST');
    });
    const before = await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' });
    await new AgentWorker(svc, cfg, { id: 'w-lost' }).tick();
    // The decision step was committed, but the run was handed back by nobody: it is the next holder's to report.
    expect((await listSteps(db, run.id)).map((s) => s.kind)).toEqual(['decision']);
    expect(await metricValue('audit_agent_step_duration_seconds', { kind: 'decision' })).toBe(before);
  });
});
