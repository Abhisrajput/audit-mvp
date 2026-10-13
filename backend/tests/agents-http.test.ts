import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, type AgentConfig } from '../src/agents/config';
import { draftTestPlans } from '../src/agents/specialists/test-plan';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { auditor as auditorUser, NEW_ENGAGEMENT, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

async function setup(agents: AgentConfig = defaultAgentConfig()) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents });
  const auditor = await signIn(app, 'auditor');
  const id = (await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201)).body.id as string;
  return { svc, app, auditor, id, worker: new AgentWorker(svc, agents, { id: 'w-http' }) };
}

describe('agent runs over HTTP', () => {
  it('start one run per engagement, for preparers only, and record who started it [REQ-26]', async () => {
    const { svc, app, auditor, id } = await setup();
    const started = await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201);
    expect(started.body).toMatchObject({ run: { status: 'runnable', startedBy: 'auditor', policy: 'rules' }, warnings: [] });
    const again = await auditor.post(`/api/engagements/${id}/runs`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RUN_ACTIVE');
    expect((await (await signIn(app, 'viewer')).post(`/api/engagements/${id}/runs`, {})).status).toBe(403);
    expect((await readTrail(svc.db.kysely, id)).at(-1)).toMatchObject({ moduleId: 'human:agent-run-start', actor: 'auditor', output: { runId: started.body.run.id } });
  });

  it('are refused while agents are switched off [REQ-29]', async () => {
    const { auditor, id } = await setup({ ...defaultAgentConfig(), enabled: false });
    const res = await auditor.post(`/api/engagements/${id}/runs`, {});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AGENT_DISABLED');
  });

  it('take a lower budget from their starter, never a higher one [REQ-29]', async () => {
    const { auditor, id } = await setup();
    expect((await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 100_000 } })).status).toBe(400);
    expect((await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 5 } }).expect(201)).body.run.budget.maxSteps).toBe(5);
  });

  it('warn an audit manager who starts one that they cannot sign its first gates', async () => {
    const { app, id } = await setup();
    const manager = await signIn(app, 'reviewer');
    const res = await manager.post(`/api/engagements/${id}/runs`, {}).expect(201);
    expect(res.body.warnings).toEqual(['You started this run, so you cannot sign its scope or RCM gates or review the findings it drafts. 0 other active audit manager(s) can.']);
  });

  it('show their steps and gates, and can be paused, resumed and cancelled [REQ-28]', async () => {
    const { svc, app, auditor, id, worker } = await setup();
    const run = (await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run;
    await worker.drain();
    const shown = (await auditor.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(shown.run).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
    expect(shown.steps.length).toBeGreaterThan(2);
    expect((await auditor.get(`/api/runs/${run.id}?afterSeq=2`).expect(200)).body.steps[0].seq).toBe(3);
    expect((await auditor.get(`/api/engagements/${id}/runs`).expect(200)).body.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body).toMatchObject([{ kind: 'scope', state: 'open' }]);
    expect((await (await signIn(app, 'viewer')).post(`/api/runs/${run.id}/pause`)).status).toBe(403);
    expect((await auditor.post(`/api/runs/${run.id}/pause`).expect(200)).body).toMatchObject({ status: 'waiting', statusReason: 'paused_by_user' });
    expect((await auditor.post(`/api/runs/${run.id}/resume`).expect(200)).body.status).toBe('runnable');
    expect((await auditor.post(`/api/runs/${run.id}/cancel`).expect(200)).body.status).toBe('cancelled');
    expect((await auditor.post(`/api/runs/${run.id}/cancel`)).status).toBe(409);
    expect((await auditor.get(`/api/engagements/${id}/gates`)).body[0].state).toBe('superseded');
    expect((await readTrail(svc.db.kysely, id)).map((b) => b.moduleId)).toEqual(expect.arrayContaining([
      'human:agent-run-start', 'human:agent-run-pause', 'human:agent-run-resume', 'human:agent-run-cancel',
    ]));
  });

  it('let an audit manager raise the budget of a run that ran out, which then resumes [REQ-29]', async () => {
    const { app, auditor, id, worker } = await setup();
    const run = (await auditor.post(`/api/engagements/${id}/runs`, { budget: { maxSteps: 1 } }).expect(201)).body.run;
    await worker.drain();
    expect((await auditor.get(`/api/runs/${run.id}`)).body.run).toMatchObject({ status: 'needs_human', statusReason: 'budget_exhausted: 1 steps' });
    const raised = { maxSteps: 50, maxTokens: run.budget.maxTokens, maxCostUsd: run.budget.maxCostUsd };
    expect((await auditor.post(`/api/runs/${run.id}/budget`, raised)).status).toBe(403);
    const manager = await signIn(app, 'reviewer');
    expect((await manager.post(`/api/runs/${run.id}/budget`, { ...raised, maxSteps: 0 })).status).toBe(400);
    expect((await manager.post(`/api/runs/${run.id}/budget`, raised).expect(200)).body).toMatchObject({ status: 'runnable', budget: raised });
  });
});

describe('test plans over HTTP', () => {
  it('let an auditor record a reason not to test a row, with the usual version check', async () => {
    const { svc, app, auditor, id } = await setup();
    await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
    const e = await svc.engagement(id);
    await svc.saveTestPlansAsAgent(id, draftTestPlans(e), { runId: 'AR-http', agent: 'test-plan', startedBy: auditorUser }, { expectedVersion: e.version! });
    const rowId = e.rcm[0].id;
    expect((await auditor.get(`/api/engagements/${id}/test-plans`).expect(200)).body[rowId].rowId).toBe(rowId);
    expect((await (await signIn(app, 'viewer')).put(`/api/engagements/${id}/test-plans/${rowId}`, { notTestedJustification: 'x' })).status).toBe(403);
    expect((await auditor.put(`/api/engagements/${id}/test-plans/${rowId}`, { rowHash: 'forged' })).status).toBe(400);
    const stale = await auditor.agent.put(`/api/engagements/${id}/test-plans/${rowId}`).set('x-csrf-token', auditor.csrf).set('If-Match', '"1"').send({ notTestedJustification: 'Retired' });
    expect(stale.status).toBe(409);
    expect((await auditor.put(`/api/engagements/${id}/test-plans/${rowId}`, { notTestedJustification: 'Control retired in March' }).expect(200)).body)
      .toMatchObject({ notTestedJustification: 'Control retired in March', editedBy: 'auditor' });
  });
});
