import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { AgentWorker } from '../src/agents/worker';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { verifyIntegrity } from '../src/ops/verify';
import { newService } from './helpers';
import { devAuthConfig, devSign, devSignGate, signIn } from './http';

type GateView = { id: string; kind: string; state: string; attempt: number };

/** A pharma engagement with an agent run started by the auditor, behind the real HTTP stack and an in-process worker. */
async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents: defaultAgentConfig() });
  const worker = new AgentWorker(svc, defaultAgentConfig(), { id: 'w-e2e' });
  const auditor = await signIn(app, 'auditor');
  const manager = await signIn(app, 'reviewer');
  const cae = await signIn(app, 'approver');
  const id = (await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201)).body.id as string;
  const run = (await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201)).body.run as { id: string };
  const state = async () => (await auditor.get(`/api/runs/${run.id}`).expect(200)).body.run as { status: string; statusReason: string };
  const gates = async () => (await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body as GateView[];
  const openGate = async (kind: string) => (await gates()).find((g) => g.kind === kind && g.state === 'open')!;
  return { svc, worker, auditor, manager, cae, id, run, state, gates, openGate };
}

describe('an agent run, end to end (offline)', () => {
  it('takes an engagement from scope to completion, stopping only for people [REQ-26, REQ-27, REQ-28]', async () => {
    const { svc, worker, auditor, manager, cae, id, run, state, openGate } = await setup();
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });
    expect((await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting rcm gate signature' });
    expect((await devSignGate(manager, 'reviewer', (await openGate('rcm')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    const planned = (await auditor.get(`/api/engagements/${id}`).expect(200)).body;
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: `awaiting test results for ${planned.rcm.length} control(s)` });
    expect(Object.keys(planned.testPlans).sort()).toEqual(planned.rcm.map((r: { id: string }) => r.id).sort());

    // Field work is the auditor's: the HPLC audit-trail control (as in tests/http.ts draftFinding) fails, the others pass.
    expect(planned.rcm.map((r: { id: string }) => r.id)).toContain('PH-DI-01');
    for (const row of planned.rcm as { id: string }[]) {
      const failing = row.id === 'PH-DI-01';
      await auditor.put(`/api/engagements/${id}/tests/${row.id}`, {
        designAdequate: true, observation: failing ? 'Audit trail review missing for 5 of 20 sequences' : 'All 20 items reviewed',
        evidenceRefs: ['EV-1'], sampleTested: 20, exceptions: failing ? 5 : 0,
      }).expect(200);
    }
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: expect.stringMatching(/^awaiting finding gate signature/) });
    const finding = (await auditor.get(`/api/engagements/${id}`).expect(200)).body.findings[0];
    expect(finding.preparedBy).toEqual(['auditor']);
    expect((await devSign(manager, 'reviewer', id, finding.id, 'review')).status!.status).toBe('signed');
    expect((await devSign(cae, 'approver', id, finding.id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting report gate signature' });
    expect((await devSignGate(cae, 'approver', (await openGate('report')).id, 'approve')).status!.status).toBe('signed');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'completed' });

    // Every agent action is in the chain as the agent's, on the starter's behalf; every signature is a person's.
    expect(verifyChain(await readTrail(svc.db.kysely)).valid).toBe(true);
    const agentEntries = (await readTrail(svc.db.kysely, id)).filter((b) => b.actor.startsWith('agent:'));
    expect(agentEntries.length).toBeGreaterThan(10);
    for (const b of agentEntries) expect(b.inputs).toMatchObject({ runId: run.id, onBehalfOf: 'auditor' });
    expect((await listSignatures(svc.db.kysely, id)).map((s) => s.userId).sort()).toEqual(['approver', 'approver', 'reviewer', 'reviewer', 'reviewer']);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual([]);
  });

  it('redrafts after a rejection, hands over when the redraft changes nothing, and again after a second rejection [REQ-26]', async () => {
    const { svc, worker, auditor, manager, id, run, state, openGate } = await setup();
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'reject', 'Bring user-access reviews into scope');
    await worker.drain();
    // Offline, the scope specialist keeps every decision already made, so its redraft is the same scope: a person takes over.
    expect(await state()).toMatchObject({ status: 'needs_human', statusReason: expect.stringMatching(/^rework produced no change: scope/) });

    const last = (await svc.engagement(id)).scope.at(-1)!;
    await auditor.put(`/api/engagements/${id}/scope`, { items: [{ controlId: last.controlId, included: !last.included }] }).expect(200);
    await auditor.post(`/api/runs/${run.id}/resume`).expect(200);
    await worker.drain();
    expect(await openGate('scope')).toMatchObject({ attempt: 2 });
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'reject', 'Still missing user-access reviews');
    await worker.drain();
    expect(await state()).toMatchObject({ status: 'needs_human', statusReason: 'gate_rejected_twice: scope' });
  });

  it('re-reviews a workpaper edited while a later gate is open, supersedes that gate, and rebuilds what was built on it [REQ-26]', async () => {
    const { svc, worker, auditor, manager, id, run, state, gates, openGate } = await setup();
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve');
    await worker.drain();
    const rcmGate = await openGate('rcm');
    const last = (await svc.engagement(id)).scope.at(-1)!;
    await auditor.put(`/api/engagements/${id}/scope`, { items: [{ controlId: last.controlId, included: !last.included }] }).expect(200);
    await worker.drain();
    expect((await gates()).find((g) => g.id === rcmGate.id)!.state).toBe('superseded');
    expect(await openGate('scope')).toMatchObject({ attempt: 2 });
    expect(await state()).toMatchObject({ status: 'waiting', statusReason: 'awaiting scope gate signature' });

    // Once the edited scope is approved, the RCM is drafted again from it before any RCM gate opens.
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve');
    await worker.drain();
    const steps = (await auditor.get(`/api/runs/${run.id}?limit=500`).expect(200)).body.steps as { kind: string; decision: { action?: { subjectKey?: string } } }[];
    expect(steps.filter((s) => s.kind === 'delegate' && s.decision.action?.subjectKey === 'rcm')).toHaveLength(2);
    expect(await openGate('rcm')).toMatchObject({ attempt: 1 });
  });
});
