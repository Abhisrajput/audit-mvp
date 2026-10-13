import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { closeFindingGate, closeGate, insertGate, listGates, supersedeOpenGates } from '../src/agents/gate-repo';
import { appendStep, assertLease, createRun, getRun, leaseNext, listSteps, markRunnable, releaseRun, requestCancel, requestPause } from '../src/agents/run-repo';
import { ensureDevUsers } from '../src/auth/dev-users';
import { appendTrail } from '../src/db/trail-repo';
import { runWithRequestId } from '../src/observability/context';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const BUDGET = { maxSteps: 50, maxTokens: 1000, maxCostUsd: 1 };

async function engagementWithRun() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const run = await createRun(svc.db.kysely, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: 'rules-1', budget: BUDGET });
  return { svc, e, run, db: svc.db.kysely };
}

const newGate = (engagementId: string, runId: string) => ({
  engagementId, runId, kind: 'scope' as const, subjectKey: 'scope', subjectId: 'scope', subjectHash: 'h', basisHash: 'b', qaReport: null,
});

describe('agent runs', () => {
  it('start runnable, and an engagement has one active run at a time [REQ-26]', async () => {
    const { db, e, run } = await engagementWithRun();
    expect(run).toMatchObject({ status: 'runnable', startedBy: 'auditor', budget: BUDGET, spent: { steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } });
    expect(run.id).toMatch(/^AR-[0-9a-f]{12}$/);
    await expect(createRun(db, { engagementId: e.id, startedBy: 'auditor', policy: 'rules', policyVersion: 'rules-1', budget: BUDGET }))
      .rejects.toMatchObject({ status: 409, code: 'RUN_ACTIVE' });
  });

  it('are leased to one worker, and to another once the lease has expired', async () => {
    const { db, run } = await engagementWithRun();
    expect(await leaseNext(db, 'w1', 60_000)).toMatchObject({ id: run.id, status: 'running', leaseOwner: 'w1' });
    expect(await leaseNext(db, 'w2', 60_000)).toBeNull();
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await leaseNext(db, 'w2', 60_000)).toMatchObject({ id: run.id, leaseOwner: 'w2' });
    expect(await releaseRun(db, run.id, 'w1', { status: 'runnable' })).toBe(false);
    expect(await releaseRun(db, run.id, 'w2', { status: 'waiting', reason: 'awaiting scope gate signature' })).toBe(true);
    expect(await getRun(db, run.id)).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature', leaseOwner: null });
  });

  it('wake when someone changes the engagement, unless paused', async () => {
    const { svc, db, e, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    await releaseRun(db, run.id, 'w1', { status: 'waiting', reason: 'awaiting scope gate signature' });
    await svc.runModule(e.id, 'scope', auditor);
    expect((await getRun(db, run.id))!.status).toBe('runnable');
    await requestPause(db, run.id);
    await svc.runModule(e.id, 'scope', auditor);
    expect(await getRun(db, run.id)).toMatchObject({ status: 'waiting', statusReason: 'paused_by_user' });
    expect((await markRunnable(db, run.id)).status).toBe('runnable');
  });

  it('turn a cancel asked for mid-iteration into a runnable run, for the worker to act on', async () => {
    const { db, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    expect((await requestCancel(db, run.id)).cancelRequested).toBe(true);
    await releaseRun(db, run.id, 'w1', { status: 'waiting', reason: 'awaiting scope gate signature' });
    expect(await getRun(db, run.id)).toMatchObject({ status: 'runnable', cancelRequested: true });
  });

  it('cancel at once when no worker holds them, superseding open gates, and refuse changes after [REQ-28]', async () => {
    const { db, e, run } = await engagementWithRun();
    await insertGate(db, newGate(e.id, run.id));
    expect(await requestCancel(db, run.id)).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    expect((await listGates(db, e.id))[0].state).toBe('superseded');
    await expect(requestCancel(db, run.id)).rejects.toMatchObject({ status: 409 });
    await expect(markRunnable(db, run.id)).rejects.toMatchObject({ status: 409 });
  });

  it('number their steps in order, and steps cannot be changed [REQ-28]', async () => {
    const { db, run } = await engagementWithRun();
    await appendStep(db, run.id, { kind: 'decision', agent: 'supervisor', decision: { a: 1 } });
    const second = await appendStep(db, run.id, { kind: 'qa', agent: 'qa', decision: { b: 2 }, trailBundleId: 'AGT-x' });
    expect(second).toMatchObject({ seq: 2, kind: 'qa', decision: { b: 2 }, trailBundleId: 'AGT-x', tokensIn: 0, costUsd: 0 });
    expect((await listSteps(db, run.id)).map((s) => s.seq)).toEqual([1, 2]);
    expect((await listSteps(db, run.id, { afterSeq: 1 })).map((s) => s.seq)).toEqual([2]);
    await expect(sql`UPDATE agent_steps SET agent = 'x'`.execute(db)).rejects.toThrow(/is append-only: /);
  });
});

describe('gates', () => {
  it('count attempts per subject, ignoring superseded gates [REQ-27]', async () => {
    const { db, e, run } = await engagementWithRun();
    const first = await insertGate(db, newGate(e.id, run.id));
    expect(first).toMatchObject({ attempt: 1, state: 'open', kind: 'scope' });
    await expect(insertGate(db, newGate(e.id, run.id))).rejects.toThrow(/gates_one_open/);
    await closeGate(db, first.id, 'rejected', 'SIG-1', 'Add the SoD controls');
    await expect(closeGate(db, first.id, 'approved', 'SIG-2', '')).rejects.toMatchObject({ status: 409 });
    await insertGate(db, newGate(e.id, run.id));
    await supersedeOpenGates(db, run.id);
    expect((await insertGate(db, newGate(e.id, run.id))).attempt).toBe(2);
    expect((await listGates(db, e.id)).map((g) => [g.attempt, g.state, g.comment])).toEqual([
      [1, 'rejected', 'Add the SoD controls'], [2, 'superseded', ''], [2, 'open', ''],
    ]);
  });
});

describe('agent trail entries', () => {
  it('name the agent as the actor, on behalf of the person who started the run, under the run id [REQ-28]', async () => {
    const { svc, e, run } = await engagementWithRun();
    const sealed = await runWithRequestId(run.id, () =>
      svc.db.kysely.transaction().execute((trx) =>
        appendTrail(trx, svc.agentBundle(e, { moduleId: 'agent:decision', agent: 'supervisor', runId: run.id, onBehalfOf: 'auditor', inputs: { stage: 'scope' }, output: { ok: true } }))));
    expect(sealed).toMatchObject({ actor: 'agent:supervisor', moduleId: 'agent:decision', requestId: run.id, inputs: { stage: 'scope', runId: run.id, onBehalfOf: 'auditor' } });
    expect(sealed.id).toMatch(/^AGT-[0-9a-f]{8}$/);
  });
});

describe('agent run fixes', () => {
  it('lets only one of two concurrent cancels win, the other a 409 [REQ-28]', async () => {
    const { db, run } = await engagementWithRun();
    const res = await Promise.allSettled([requestCancel(db, run.id), requestCancel(db, run.id)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    expect((await getRun(db, run.id))!.status).toBe('cancelled');
  });

  it('fences writes to the lease holder', async () => {
    const { db, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    await expect(assertLease(db, run.id, 'w1')).resolves.toBeUndefined();
    await expect(assertLease(db, run.id, 'w2')).rejects.toMatchObject({ status: 409 });
    await releaseRun(db, run.id, 'w1', { status: 'waiting', reason: 'x' });
    await expect(assertLease(db, run.id, 'w1')).rejects.toMatchObject({ status: 409 });
  });

  it('cancel and pause a running run whose lease has expired', async () => {
    const { db, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await requestCancel(db, run.id)).toMatchObject({ status: 'cancelled', leaseOwner: null, leaseUntil: null });
  });

  it('pauses an expired-lease run at once', async () => {
    const { db, run } = await engagementWithRun();
    await leaseNext(db, 'w1', 60_000);
    await sql`UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = ${run.id}`.execute(db);
    expect(await requestPause(db, run.id)).toMatchObject({ status: 'waiting', statusReason: 'paused_by_user', leaseOwner: null });
  });

  it('closes a finding gate only for the content it showed, and ignores one already superseded', async () => {
    const { db, e, run } = await engagementWithRun();
    const fg = { ...newGate(e.id, run.id), kind: 'finding' as const, subjectKey: 'finding:F1', subjectId: 'F1', subjectHash: 'h1' };
    await insertGate(db, fg);
    await closeFindingGate(db, e.id, 'F1', 'other', 'approved', 'SIG-1', '');
    expect((await listGates(db, e.id))[0].state).toBe('superseded');
    await closeFindingGate(db, e.id, 'F1', 'h1', 'approved', 'SIG-1', '');
    expect((await listGates(db, e.id))[0].state).toBe('superseded');
    await insertGate(db, fg);
    await closeFindingGate(db, e.id, 'F1', 'h1', 'approved', 'SIG-2', 'ok');
    expect((await listGates(db, e.id))[1]).toMatchObject({ state: 'approved', signatureId: 'SIG-2' });
  });
});
