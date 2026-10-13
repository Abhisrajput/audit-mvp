import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig, type AgentConfig } from '../src/agents/config';
import { listGates } from '../src/agents/gate-repo';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, getRun, leaseNext, listSteps, markRunnable, requestCancel, requestPause } from '../src/agents/run-repo';
import type { Action, Menu, Policy } from '../src/agents/types';
import { AgentWorker, chooseDecision } from '../src/agents/worker';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { AppError } from '../src/errors';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

// Lets a test act between the worker's reconcile and its decision (the graph input is loaded in between).
const hooks = vi.hoisted(() => ({ beforeGraph: null as null | (() => Promise<void>) }));
vi.mock('../src/agents/state', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/agents/state')>();
  return { ...real, loadGraphInput: async (...args: Parameters<typeof real.loadGraphInput>) => {
    await hooks.beforeGraph?.();
    return real.loadGraphInput(...args);
  } };
});

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({ ...defaultAgentConfig(), ...over });

async function started(budget = defaultAgentConfig().budget) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const run = await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: RULES_VERSION, budget });
  return { svc, e, run, db: svc.db.kysely, worker: new AgentWorker(svc, cfg(), { id: 'w1' }) };
}

describe('the agent worker', () => {
  it('takes a new engagement offline to its scope gate, recording every decision in the trail [REQ-26, REQ-28]', async () => {
    const { e, run, db, worker } = await started();
    expect(await worker.drain()).toBeGreaterThan(2);
    const after = (await getRun(db, run.id))!;
    expect(after).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature', leaseOwner: null });
    const steps = await listSteps(db, run.id);
    const decisions = steps.filter((s) => s.kind === 'decision');
    expect(decisions).toHaveLength(after.spent.steps);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['decision', 'delegate', 'qa', 'tool_call']));
    const trail = await readTrail(db, e.id);
    for (const d of decisions) {
      expect(trail.find((b) => b.id === d.trailBundleId)).toMatchObject({ moduleId: 'agent:decision', actor: 'agent:supervisor', requestId: run.id });
    }
    expect(await listGates(db, e.id)).toMatchObject([{ kind: 'scope', state: 'open' }]);
  });

  it('does nothing while agents are switched off [REQ-29]', async () => {
    const { svc, db, run } = await started();
    expect(await new AgentWorker(svc, cfg({ enabled: false })).tick()).toBe('idle');
    expect((await getRun(db, run.id))!.status).toBe('runnable');
  });

  it('stops at its step budget and hands the run to a person [REQ-29]', async () => {
    const { db, run, worker } = await started({ maxSteps: 2, maxTokens: 1000, maxCostUsd: 1 });
    await worker.drain();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'budget_exhausted: 2 steps' });
    expect((await listSteps(db, run.id)).filter((s) => s.kind === 'decision')).toHaveLength(2);
  });

  it('lets another worker pick up a run whose worker died, without repeating a step', async () => {
    const { svc, db, run, worker } = await started();
    await worker.tick();
    expect(await leaseNext(db, 'dead-worker', 60_000)).toMatchObject({ id: run.id });
    const second = new AgentWorker(svc, cfg(), { id: 'w2' });
    expect(await second.tick()).toBe('idle');
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await second.tick()).toBe('worked');
    const seqs = (await listSteps(db, run.id)).map((s) => s.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('backs off for a minute after three edit conflicts in a row', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new AppError(409, 'changed meanwhile', 'VERSION_CONFLICT'));
    await worker.tick();
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', conflictStreak: 2 });
    await worker.tick();
    const r = (await getRun(db, run.id))!;
    expect(r).toMatchObject({ status: 'waiting', statusReason: 'engagement being edited', conflictStreak: 0 });
    expect(Date.parse(r.wakeAt!) - Date.now()).toBeGreaterThan(50_000);
    expect(await worker.tick()).toBe('idle');
  });

  it('hands the run to a person after three failed steps in a row', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new Error('model endpoint unreachable'));
    await worker.drain();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'error: model endpoint unreachable' });
  });

  it('stops and asks a person when the rails refuse an action [REQ-27]', async () => {
    const { svc, db, run, worker } = await started();
    vi.spyOn(svc, 'runModuleAsAgent').mockRejectedValue(new AppError(403, 'An agent may not sign', 'AGENT_FORBIDDEN'));
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: 'agent_forbidden: An agent may not sign' });
    expect((await listSteps(db, run.id)).at(-1)).toMatchObject({ kind: 'tool_call', agent: 'rails', decision: { refused: 'An agent may not sign' } });
  });

  it('honours a cancel that arrives mid-step, and takes no further step', async () => {
    const { svc, db, run, worker } = await started();
    const original = svc.runModuleAsAgent.bind(svc);
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementationOnce(async (...args) => {
      await requestCancel(db, run.id);
      return original(...args);
    });
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', cancelRequested: true });
    const before = (await listSteps(db, run.id)).length;
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    expect(await listSteps(db, run.id)).toHaveLength(before);
    expect(await worker.tick()).toBe('idle');
  });

  it('writes no step once another worker has taken the run mid-iteration [REQ-29]', async () => {
    const { db, run, worker } = await started();
    hooks.beforeGraph = async () => { await sql`UPDATE agent_runs SET lease_owner = 'thief' WHERE id = ${run.id}`.execute(db); };
    try {
      expect(await worker.tick()).toBe('worked');
    } finally {
      hooks.beforeGraph = null;
    }
    expect(await listSteps(db, run.id)).toHaveLength(0);
    expect(await getRun(db, run.id)).toMatchObject({ status: 'running', leaseOwner: 'thief' });
  });

  it('supersedes the open gates of a held run on the worker\'s next look after a cancel [REQ-28]', async () => {
    const { db, e, run, worker } = await started();
    await worker.drain();
    expect(await listGates(db, e.id)).toMatchObject([{ state: 'open' }]);
    // The run is held by a live worker when the cancel arrives, so it is only flagged.
    await sql`UPDATE agent_runs SET status = 'running', lease_owner = 'w9', lease_until = now() + interval '1 minute' WHERE id = ${run.id}`.execute(db);
    await requestCancel(db, run.id);
    expect(await listGates(db, e.id)).toMatchObject([{ state: 'open' }]);
    await sql`UPDATE agent_runs SET status = 'runnable', lease_owner = NULL, lease_until = NULL WHERE id = ${run.id}`.execute(db);
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'cancelled' });
    expect(await listGates(db, e.id)).toMatchObject([{ state: 'superseded' }]);
  });

  it('leaves a paused run alone until it is resumed', async () => {
    const { db, run, worker } = await started();
    await requestPause(db, run.id);
    expect(await worker.tick()).toBe('idle');
    await markRunnable(db, run.id);
    expect(await worker.tick()).toBe('worked');
  });

  it('hands the run to a person when its starter can no longer prepare audit work', async () => {
    const { db, run, worker } = await started();
    await sql`UPDATE users SET role = 'viewer' WHERE id = 'auditor'`.execute(db);
    await worker.tick();
    expect(await getRun(db, run.id)).toMatchObject({ status: 'needs_human', statusReason: expect.stringMatching(/can no longer prepare/) });
  });
});

describe('choosing a decision', () => {
  const gate: Action = { type: 'open_gate', subjectKey: 'scope' };
  const escalate: Action = { type: 'escalate', reason: 'QA found issues' };
  const menu: Menu = {
    stage: 'scope', actions: [gate, escalate], qaThreshold: 70,
    qa: { subjectKey: 'scope', subjectHash: 'h', mode: 'review', reviewer: 't', score: 90, issues: [] },
  };
  const rogue: Policy = {
    kind: 'llm', version: 'rogue-1',
    decide: async () => ({ action: { type: 'complete' }, rationale: 'Skip the gates', policy: 'llm', policyVersion: 'rogue-1' }),
  };

  it('falls back to the rules when a policy picks an action the graph does not allow [REQ-26]', async () => {
    const d = await chooseDecision(rogue, menu);
    expect(d).toMatchObject({ action: gate, policy: 'rules' });
    expect(d.rationale).toMatch(/not allowed/);
  });

  it('asks no policy when only one action is allowed [REQ-26]', async () => {
    expect(await chooseDecision(rogue, { ...menu, actions: [escalate] })).toMatchObject({ action: escalate, policy: 'forced', policyVersion: 'rogue-1' });
  });
});
