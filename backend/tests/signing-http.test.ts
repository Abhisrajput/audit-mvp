import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { appWithDevUsers, signIn } from './http';

type Session = Awaited<ReturnType<typeof signIn>>;

/** Runs the pharma chain as the auditor until one draft finding exists. */
async function draftFinding(app: Awaited<ReturnType<typeof appWithDevUsers>>['app']) {
  const auditor = await signIn(app, 'auditor');
  const created = await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201);
  const id = created.body.id as string;
  await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
  await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
  const gaps = await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200);
  return { auditor, id, fid: gaps.body.engagement.findings[0].id as string };
}

/** The signing pop-up for a demo user: start, read the form, confirm. */
async function devSign(user: Session, userId: string, id: string, fid: string, action: string, confirm = userId) {
  const intent = await user.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action, comment: 'agreed' });
  if (intent.status !== 201) return { intent, status: null as null | { status: string; code: string | null } };
  const popup = await user.get(intent.body.reauthUrl).expect(200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
  const done = await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm });
  const status = (await user.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
  return { intent, popup, done, nonce, status };
}

describe('signing over HTTP', () => {
  it('no longer signs without re-authentication', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const res = await reviewer.post(`/api/engagements/${id}/findings/${fid}/signoff`, { action: 'review' });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  it('signs after re-authentication and shows who signed, what it means, when and how [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    expect(r.intent.body).toMatchObject({ method: 'dev', reauthUrl: `/auth/sign/${r.intent.body.intentId}` });
    expect(r.popup!.text).toContain('Reviewed');
    expect(r.done!.text).toMatch(/signature was recorded/);
    expect(r.status).toEqual({ status: 'signed', code: null, message: null });

    const approver = await signIn(app, 'approver');
    expect((await devSign(approver, 'approver', id, fid, 'approve')).status!.status).toBe('signed');

    const e = (await approver.get(`/api/engagements/${id}`).expect(200)).body;
    const signOffs = e.findings[0].signOffs;
    expect(signOffs.map((s: any) => [s.userName, s.meaning, s.reauth.method, s.broken])).toEqual([
      ['Ravi Reviewer', 'Reviewed', 'dev', false],
      ['Priya QA Head', 'Approved', 'dev', false],
    ]);
    expect(signOffs.every((s: any) => !Number.isNaN(Date.parse(s.at)) && !Number.isNaN(Date.parse(s.reauth.at)))).toBe(true);
    expect((await listSignatures(svc.db.kysely, id)).map((s) => s.intentId)).toEqual([r.intent.body.intentId, expect.stringMatching(/^INT-/)]);
  });

  it('refuses a confirmation by someone else and trails the failure', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review', 'approver');
    expect(r.status).toMatchObject({ status: 'failed', code: 'REAUTH_USER_MISMATCH' });
    expect((await reviewer.get(`/api/engagements/${id}`)).body.findings[0].status).toBe('draft');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    const failed = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:sign-failed')!;
    expect(failed).toMatchObject({ actor: 'reviewer', inputs: { engagementId: id, findingId: fid, action: 'review' }, output: { code: 'REAUTH_USER_MISMATCH' } });
  });

  it('uses a signing request once only', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    const again = await reviewer.agent.post(`${r.intent.body.reauthUrl}/dev`).type('form').send({ nonce: r.nonce, confirm: 'reviewer' });
    expect(again.text).not.toMatch(/signature was recorded/);
    expect(await listSignatures(svc.db.kysely, id)).toHaveLength(1);
    expect((await reviewer.get(`/api/sign-intents/${r.intent.body.intentId}`)).body.status).toBe('signed');
  });

  it('expires a signing request after five minutes', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    expect(Date.parse(intent.body.expiresAt) - Date.now()).toBeGreaterThan(4.9 * 60_000);
    const popup = await reviewer.get(intent.body.reauthUrl).expect(200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
    await sql`UPDATE sign_intents SET expires_at = now() - interval '1 second'`.execute(svc.db.kysely);
    await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body).toMatchObject({ status: 'failed', code: 'INTENT_EXPIRED' });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await reviewer.get(intent.body.reauthUrl)).status).toBe(410);
  });

  it('refuses to sign a finding that was edited after the request', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const popup = await reviewer.get(intent.body.reauthUrl).expect(200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
    await auditor.put(`/api/engagements/${id}/findings/${fid}`, { condition: 'Six of twenty sequences lacked audit trail review.' }).expect(200);
    const done = await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect(done.text).toMatch(/changed after you started signing/);
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body.code).toBe('CONTENT_CHANGED');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it("keeps one person's signing request away from everyone else", async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get(intent.body.reauthUrl)).status).toBe(404);
    expect((await viewer.get(`/api/sign-intents/${intent.body.intentId}`)).status).toBe(404);
    await viewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'viewer' }).expect(404);
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body.status).toBe('pending');
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it('checks roles and segregation of duties before asking anyone to re-authenticate [REQ-17]', async () => {
    const { app } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    expect((await auditor.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' })).status).toBe(403);
    const reviewer = await signIn(app, 'reviewer');
    await reviewer.put(`/api/engagements/${id}/findings/${fid}`, { title: 'Audit trail review not evidenced' }).expect(200);
    const sod = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' });
    expect(sod.status).toBe(403);
    expect(sod.body.code).toBe('SOD_VIOLATION');
  });

  it('shows a signature as broken if the signed content is altered behind the application [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    await sql`UPDATE findings SET data = jsonb_set(data, '{condition}', '"rewritten quietly"') WHERE id = ${fid}`.execute(svc.db.kysely);
    const e = (await reviewer.get(`/api/engagements/${id}`)).body;
    expect(e.findings[0].signOffs[0].broken).toBe(true);
  });
});
