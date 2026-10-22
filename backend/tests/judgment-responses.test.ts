import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { subjectInfo } from '../src/agents/subjects';
import { AgentWorker } from '../src/agents/worker';
import { auditor as auditorUser } from './helpers';
import { createApp } from '../src/app';
import type { Engagement } from '../src/engine/types';
import { verifyIntegrity } from '../src/ops/verify';
import { appWithDevUsers, devAuthConfig, devSign, devSignGate, draftFinding, signIn } from './http';

describe('management responses (spec §3.3) [REQ-34]', () => {
  it('is refused before approval, recorded after it without touching the signature, reopens the report, and is served with its history [REQ-34]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor: user, id, fid } = await draftFinding(app);
    const body = { response: 'partially_agree', owner: 'Plant manager', dueDate: '2026-12-31', actionPlan: 'Retrain the line leads' };
    const early = await user.post(`/api/engagements/${id}/findings/${fid}/responses`, body);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('FINDING_NOT_APPROVED');
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    const approver = await signIn(app, 'approver');
    await devSign(approver, 'approver', id, fid, 'approve');
    const reportBasisBefore = subjectInfo(await svc.engagement(id), 'report')!.basis;
    const created = await user.post(`/api/engagements/${id}/findings/${fid}/responses`, body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ findingId: fid, response: 'partially_agree', recordedBy: 'auditor' });
    // svc.engagement() does not run withSignatureStatus; the HTTP path does, so the signature check goes through it.
    const shown = (await user.get(`/api/engagements/${id}`).expect(200)).body as Engagement;
    const f = shown.findings.find((x) => x.id === fid)!;
    expect(f.signOffs.length).toBeGreaterThanOrEqual(2);
    expect(f.signOffs.every((s) => !s.broken && !s.legacy)).toBe(true);
    expect(f.signatureIssues ?? []).toEqual([]);
    expect(f.status).toBe('approved');
    const after = await svc.engagement(id);
    expect(after.responses[fid].id).toBe(created.body.id);
    expect(subjectInfo(after, 'report')!.basis).not.toBe(reportBasisBefore);
    expect((await svc.trailFor(id)).some((b) => b.moduleId === 'human:management-response' && b.id === created.body.trailBundleId)).toBe(true);
    const again = await user.post(`/api/engagements/${id}/findings/${fid}/responses`, { ...body, response: 'agree' });
    expect(again.status).toBe(201);
    const history = await user.get(`/api/engagements/${id}/findings/${fid}/responses`).expect(200);
    expect(history.body.map((r: { response: string }) => r.response)).toEqual(['partially_agree', 'agree']);
    const report = await verifyIntegrity(svc.db.kysely, null);
    expect(report.signatures.problems).toEqual([]);
    expect(report.records).toEqual({ checked: 2, problems: [] });
  });

  it('is refused once the report gate is approved [REQ-34]', async () => {
    const { svc } = await appWithDevUsers();
    const cfg = defaultAgentConfig();
    const served = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { agents: cfg });
    const worker = new AgentWorker(svc, cfg, { id: 'w-resp' });
    const auditor = await signIn(served, 'auditor');
    const manager = await signIn(served, 'reviewer');
    const cae = await signIn(served, 'approver');
    const id = (await auditor.post('/api/engagements', {
      name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
      auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
    }).expect(201)).body.id as string;
    await auditor.post(`/api/engagements/${id}/runs`, {}).expect(201);
    const openGate = async (kind: string) => ((await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body as { id: string; kind: string; state: string }[]).find((g) => g.kind === kind && g.state === 'open')!;
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('scope')).id, 'approve');
    await worker.drain();
    await devSignGate(manager, 'reviewer', (await openGate('rcm')).id, 'approve');
    await worker.drain();
    const planned = (await auditor.get(`/api/engagements/${id}`).expect(200)).body;
    for (const row of planned.rcm as { id: string }[]) {
      const failing = row.id === 'PH-DI-01';
      await auditor.put(`/api/engagements/${id}/tests/${row.id}`, {
        designAdequate: true, observation: failing ? 'Audit trail review missing for 5 of 20 sequences' : 'All 20 items reviewed',
        evidenceRefs: ['EV-1'], sampleTested: 20, exceptions: failing ? 5 : 0,
      }).expect(200);
    }
    await worker.drain();
    const fid = (await auditor.get(`/api/engagements/${id}`).expect(200)).body.findings[0].id as string;
    await devSign(manager, 'reviewer', id, fid, 'review');
    await devSign(cae, 'approver', id, fid, 'approve');
    await worker.drain();
    const input = { response: 'agree' as const, owner: 'Plant manager' };
    const actor = auditorUser;
    // Before the report gate is approved a response is accepted (and supersedes the open report gate).
    const gateRows = async () => (await auditor.get(`/api/engagements/${id}/gates`).expect(200)).body as { id: string; kind: string; state: string }[];
    const reportGateBefore = await openGate('report');
    await svc.recordManagementResponse(id, fid, input, actor);
    await worker.drain();
    expect((await gateRows()).find((g) => g.id === reportGateBefore.id)!.state).toBe('superseded');
    const reportGateAfter = await openGate('report');
    expect(reportGateAfter.id).not.toBe(reportGateBefore.id);
    await devSignGate(cae, 'approver', (await openGate('report')).id, 'approve');
    await expect(svc.recordManagementResponse(id, fid, input, actor)).rejects.toMatchObject({ status: 409, code: 'RESPONSE_LOCKED' });
  });
});
