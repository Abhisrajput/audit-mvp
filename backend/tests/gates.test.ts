import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { getGate, insertGate } from '../src/agents/gate-repo';
import { createRun, getRun, leaseNext, releaseRun, requestCancel } from '../src/agents/run-repo';
import { findingKey, subjectInfo } from '../src/agents/subjects';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyIntegrity } from '../src/ops/verify';
import type { AuditService } from '../src/service';
import { approver, auditor, engagementWithFailedControl, NEW_ENGAGEMENT, reviewer, unattended } from './helpers';
import { appWithDevUsers, devSignGate, signIn } from './http';

const BUDGET = { maxSteps: 50, maxTokens: 1000, maxCostUsd: 1 };

/** The engagement's agent run waiting at an open gate on `key`, opened the way the executor opens one. */
async function waitingAtGate(svc: AuditService, engagementId: string, key: string, startedBy = 'auditor') {
  const e = await svc.engagement(engagementId);
  const run = await createRun(svc.db.kysely, { engagementId, startedBy, policy: 'rules', policyVersion: 'rules-1', budget: BUDGET });
  const s = subjectInfo(e, key)!;
  const gate = await insertGate(svc.db.kysely, {
    engagementId, runId: run.id, kind: s.gateKind!, subjectKey: key, subjectId: s.subjectId, subjectHash: s.hash, basisHash: s.basis, qaReport: null,
  });
  await leaseNext(svc.db.kysely, 'w', 60_000);
  await releaseRun(svc.db.kysely, run.id, 'w', { status: 'waiting', reason: `awaiting ${s.gateKind} gate signature` });
  return { run, gate };
}

async function scoped(svc: AuditService) {
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  return e.id;
}

describe('workpaper gates', () => {
  it('are signed after re-authentication, bound to the workpaper, and wake the run [REQ-27, REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { run, gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    const r = await devSignGate(manager, 'reviewer', gate.id, 'approve');
    expect(r.popup!.text).toContain('the <b>scope</b> workpaper');
    expect(r.status).toEqual({ status: 'signed', code: null, message: null });
    const closed = (await getGate(svc.db.kysely, gate.id))!;
    expect(closed).toMatchObject({ state: 'approved', signatureId: expect.stringMatching(/^SIG-/) });
    const [sig] = await listSignatures(svc.db.kysely, id);
    expect(sig).toMatchObject({
      id: closed.signatureId, subjectKind: 'workpaper', workpaper: 'scope', gateId: gate.id, findingId: null, meaning: 'Approved',
      contentHash: gate.subjectHash, reauthMethod: 'dev', userId: 'reviewer',
    });
    expect((await readTrail(svc.db.kysely, id)).at(-1)).toMatchObject({
      moduleId: 'human:gate-sign', actor: 'reviewer', output: { signatureId: sig.id, gateId: gate.id, meaning: 'Approved' },
    });
    expect((await getRun(svc.db.kysely, run.id))!.status).toBe('runnable');
  });

  it("are signed only by the right role, and never by the run's starter [REQ-17, REQ-27]", async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope', 'reviewer');
    for (const userId of ['auditor', 'approver']) {
      expect((await (await signIn(app, userId)).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' })).status).toBe(403);
    }
    const starter = await (await signIn(app, 'reviewer')).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' });
    expect(starter.status).toBe(403);
    expect(starter.body.code).toBe('SOD_VIOLATION');
  });

  it('ask the CAE, not an audit manager, to sign the report [REQ-27]', async () => {
    const { app, svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    await svc.runModule(e.id, 'report', auditor);
    const { gate } = await waitingAtGate(svc, e.id, 'report');
    expect((await (await signIn(app, 'reviewer')).post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' })).status).toBe(403);
    expect((await devSignGate(await signIn(app, 'approver'), 'approver', gate.id, 'approve')).status!.status).toBe('signed');
  });

  it('refuse a signature on a workpaper that changed after the gate opened, or during signing', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    const intent = await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await manager.get(intent.body.reauthUrl)).text)![1];
    const first = (await svc.engagement(id)).scope[0];
    await svc.setScope(id, [{ controlId: first.controlId, included: !first.included }], auditor);
    await manager.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect((await manager.get(`/api/sign-intents/${intent.body.intentId}`)).body.code).toBe('GATE_STALE');
    const again = await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'approve' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('GATE_STALE');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('open');
  });

  it('need a reason to reject, and keep it for the agent to redraft from', async () => {
    const { app, svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    const manager = await signIn(app, 'reviewer');
    expect((await manager.post(`/api/gates/${gate.id}/sign-intents`, { action: 'reject', comment: ' ' })).status).toBe(400);
    expect((await devSignGate(manager, 'reviewer', gate.id, 'reject', 'Bring the allergen controls into scope')).status!.status).toBe('signed');
    expect(await getGate(svc.db.kysely, gate.id)).toMatchObject({ state: 'rejected', comment: 'Bring the allergen controls into scope' });
  });

  it('are checked by verify against the workpaper history, the trail and the gate [REQ-24]', async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    await svc.signGate(gate.id, 'approve', 'In scope as proposed', reviewer, unattended);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual([]);
    await sql`ALTER TABLE workpaper_revisions DISABLE TRIGGER workpaper_revisions_append_only`.execute(svc.db.kysely);
    await sql`UPDATE workpaper_revisions SET content_hash = 'tampered' WHERE engagement_id = ${id}`.execute(svc.db.kysely);
    await sql`ALTER TABLE gates DISABLE TRIGGER gates_guard`.execute(svc.db.kysely);
    await sql`UPDATE gates SET signature_id = 'SIG-missing' WHERE id = ${gate.id}`.execute(svc.db.kysely);
    expect((await verifyIntegrity(svc.db.kysely, null)).signatures.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/scope gate GATE-.*the signed content is not in the workpaper's history/),
      expect.stringMatching(/^Gate GATE-.* is approved, but its signature SIG-missing is missing/),
    ]));
  });
});

describe('finding gates', () => {
  it('close when the finding is approved, not when it is reviewed [REQ-27]', async () => {
    const { svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const { gate } = await waitingAtGate(svc, e.id, findingKey(f.rowId));
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('open');
    await svc.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    expect(await getGate(svc.db.kysely, gate.id)).toMatchObject({ state: 'approved', signatureId: expect.stringMatching(/^SIG-/) });
  });

  it('are superseded, not closed, when the finding changed after the gate opened', async () => {
    const { svc } = await appWithDevUsers();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const { gate } = await waitingAtGate(svc, e.id, findingKey(f.rowId));
    await svc.editFinding(e.id, f.id, { title: 'Edited after the gate opened' }, auditor);
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    await svc.signOff(e.id, f.id, 'approve', '', approver, {}, unattended);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('superseded');
  });
});

describe('gate signing refusals', () => {
  it('refuses a gate that is already decided, or superseded', async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope');
    await svc.signGate(gate.id, 'approve', 'ok', reviewer, unattended);
    await expect(svc.signGate(gate.id, 'approve', 'again', reviewer, unattended)).rejects.toMatchObject({ status: 409 });
    expect(await listSignatures(svc.db.kysely, id)).toHaveLength(1);

    const e2 = await scoped(svc);
    const second = await waitingAtGate(svc, e2, 'scope');
    await requestCancel(svc.db.kysely, second.run.id);
    expect((await getGate(svc.db.kysely, second.gate.id))!.state).toBe('superseded');
    await expect(svc.signGate(second.gate.id, 'approve', 'ok', reviewer, unattended)).rejects.toMatchObject({ status: 409 });
    expect(await listSignatures(svc.db.kysely, e2)).toEqual([]);
  });

  it("refuses the run's starter when signGate is called directly [REQ-17]", async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { gate } = await waitingAtGate(svc, id, 'scope', 'reviewer');
    await expect(svc.signGate(gate.id, 'approve', 'ok', reviewer, unattended)).rejects.toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it('refuses a gate whose run has ended', async () => {
    const { svc } = await appWithDevUsers();
    const id = await scoped(svc);
    const { run, gate } = await waitingAtGate(svc, id, 'scope');
    await sql`UPDATE agent_runs SET status = 'failed' WHERE id = ${run.id}`.execute(svc.db.kysely);
    await expect(svc.signGate(gate.id, 'approve', 'ok', reviewer, unattended)).rejects.toMatchObject({ status: 409, code: 'RUN_NOT_ACTIVE' });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await getGate(svc.db.kysely, gate.id))!.state).toBe('open');
  });
});
