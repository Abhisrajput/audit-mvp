import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { findingContentHash } from '../src/signing/content-hash';
import { appWithDevUsers, failTrailWrites, signIn } from './http';

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
  it('shows a signature as broken even when the content and its recorded hash are rewritten together [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    const approver = await signIn(app, 'approver');
    await devSign(approver, 'approver', id, fid, 'approve');
    const csvBefore = (await approver.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    expect(csvBefore.split('\n')[0]).toContain(',signatures,');
    expect(csvBefore).toMatch(/Approved\|Priya QA Head\|cae\|[^|]+\|dev\|SIG-[0-9a-f]{12}\|valid/);

    // Rewrite the condition and recompute every recorded hash in the JSONB, as a database owner might:
    // they can switch off the approved-finding lock, but cannot rewrite the append-only signature rows.
    await sql`ALTER TABLE findings DISABLE TRIGGER findings_lock_approved`.execute(svc.db.kysely);
    await sql`UPDATE findings SET data = jsonb_set(data, '{condition}', '"rewritten quietly"') WHERE id = ${fid}`.execute(svc.db.kysely);
    const tampered = (await svc.engagement(id)).findings[0];
    const newHash = JSON.stringify(findingContentHash(tampered));
    await sql`UPDATE findings SET data = jsonb_set(jsonb_set(data, '{signOffs,0,contentHash}', ${newHash}::jsonb), '{signOffs,1,contentHash}', ${newHash}::jsonb) WHERE id = ${fid}`.execute(svc.db.kysely);

    const e = (await reviewer.get(`/api/engagements/${id}`)).body;
    expect(e.findings[0].signOffs.map((x: any) => x.broken)).toEqual([true, true]);
    const csv = (await approver.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    expect(csv).toMatch(/Approved\|Priya QA Head\|cae\|[^|]+\|dev\|SIG-[0-9a-f]{12}\|broken/);
  });

  it('shows an imported sign-off without a signature record as legacy, never as re-authenticated', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    // An MVP-era / imported sign-off by someone with no signature record at all; it claims OIDC re-authentication.
    const imported = { userId: 'viewer', userName: 'Imported Signer', role: 'cae', meaning: 'Approved', comment: '', at: '2026-01-01T00:00:00.000Z', reauth: { method: 'oidc', at: '2026-01-01T00:00:00.000Z' } };
    await sql`UPDATE findings SET data = jsonb_insert(data, '{signOffs,-1}', ${JSON.stringify(imported)}::jsonb, true) WHERE id = ${fid}`.execute(svc.db.kysely);
    const signOffs = (await reviewer.get(`/api/engagements/${id}`)).body.findings[0].signOffs;
    expect(signOffs[1]).toMatchObject({ userName: 'Imported Signer', legacy: true, broken: false });
    expect(signOffs[0]).toMatchObject({ legacy: false, broken: false });
    const csv = (await reviewer.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    expect(csv).toMatch(/Approved\|Imported Signer\|cae\|[^|]+\|none\|\|legacy/);
    expect(csv).not.toMatch(/\|oidc\|/);
  });

  it('shows a sign-off whose signature id was stripped as broken, not legacy [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    const approver = await signIn(app, 'approver');
    await devSign(approver, 'approver', id, fid, 'approve');
    const [, approval] = await listSignatures(svc.db.kysely, id);
    await sql`ALTER TABLE findings DISABLE TRIGGER findings_lock_approved`.execute(svc.db.kysely);
    await sql`UPDATE findings SET data = data #- '{signOffs,1,signatureId}' WHERE id = ${fid}`.execute(svc.db.kysely);
    const s = (await reviewer.get(`/api/engagements/${id}`)).body.findings[0].signOffs[1];
    expect(s).toMatchObject({ broken: true, legacy: false, signatureId: approval.id, userName: 'Priya QA Head' });
    const csv = (await approver.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    expect(csv).toContain(`|dev|${approval.id}|broken`);
  });

  it('reports a signature that was deleted from the finding [REQ-19]', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    const approver = await signIn(app, 'approver');
    await devSign(approver, 'approver', id, fid, 'approve');
    const [review] = await listSignatures(svc.db.kysely, id);
    await sql`ALTER TABLE findings DISABLE TRIGGER findings_lock_approved`.execute(svc.db.kysely);
    await sql`UPDATE findings SET data = data #- '{signOffs,0}' WHERE id = ${fid}`.execute(svc.db.kysely);

    const f = (await reviewer.get(`/api/engagements/${id}`)).body.findings[0];
    expect(f.signOffs.map((x: any) => x.meaning)).toEqual(['Approved']);
    expect(f.signatureIssues).toEqual([`Signature ${review.id} (Reviewed by Ravi Reviewer) is recorded but missing from the finding`]);
    const csv = (await reviewer.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    const [header, row] = csv.split('\n');
    expect(header).toContain(',signatures,signature_issues,');
    expect(row).toContain(`"Signature ${review.id} (Reviewed by Ravi Reviewer) is recorded but missing from the finding"`);
    await auditor.post(`/api/engagements/${id}/modules/report/run`).expect(200);
    const md = (await auditor.get(`/api/engagements/${id}/report.md`).expect(200)).text;
    expect(md).toContain(`**Signature issues:** Signature ${review.id} (Reviewed by Ravi Reviewer) is recorded but missing from the finding`);
    // The issue is shown, never stored.
    expect((await svc.engagement(id)).findings[0].signatureIssues).toBeUndefined();
  });

  it('reports nothing for signatures on content that was edited since (history, not tampering)', async () => {
    const { app, svc } = await appWithDevUsers();
    const { auditor, id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await devSign(reviewer, 'reviewer', id, fid, 'review');
    await auditor.put(`/api/engagements/${id}/findings/${fid}`, { condition: 'Six of twenty sequences lacked audit trail review.' }).expect(200);
    const f = (await reviewer.get(`/api/engagements/${id}`)).body.findings[0];
    expect(f.signOffs).toEqual([]);
    expect(f.signatureIssues).toBeUndefined();
    expect(await listSignatures(svc.db.kysely, id)).toHaveLength(1);
    const csv = (await reviewer.get(`/api/engagements/${id}/findings.csv`).expect(200)).text;
    expect(csv.split('\n')[1]).toMatch(/,"","","RUN-[0-9a-f]+"$/); // no signatures, no signature issues, then the bundle id
  });

  it('marks the request failed, never stuck claimed, when the signature cannot be written', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    await failTrailWrites(svc.db, ['human:sign-off']);
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    expect(r.status).toMatchObject({ status: 'failed', code: 'INTERNAL' });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
    expect((await readTrail(svc.db.kysely)).some((b) => b.moduleId === 'identity:sign-failed')).toBe(true);
  });

  it('signs exactly once when the confirmation is posted twice at the same time', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    const post = () => reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    const results = await Promise.all([post(), post()]);
    expect(results.filter((x) => /signature was recorded/.test(x.text))).toHaveLength(1);
    expect(await listSignatures(svc.db.kysely, id)).toHaveLength(1);
    expect((await reviewer.get(`/api/sign-intents/${intent.body.intentId}`)).body.status).toBe('signed');
    // A replay after the request is used is turned away without a misleading failure entry.
    const trailCount = (await readTrail(svc.db.kysely)).filter((b) => b.moduleId === 'identity:sign-failed').length;
    const replay = await post();
    expect(replay.text).toMatch(/no longer valid/);
    expect((await readTrail(svc.db.kysely)).filter((b) => b.moduleId === 'identity:sign-failed')).toHaveLength(trailCount);
  });

  it('records a confirmation by an account that lost its role as a failed attempt', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    await sql`UPDATE users SET role = NULL WHERE id = 'reviewer'`.execute(svc.db.kysely);
    const done = await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' });
    expect(done.text).not.toMatch(/signature was recorded/);
    const row = await svc.db.kysely.selectFrom('sign_intents').selectAll().where('id', '=', intent.body.intentId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', failure_code: 'REAUTH_REQUIRED' });
    expect((await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:sign-failed')).toMatchObject({ actor: 'reviewer', output: { code: 'REAUTH_REQUIRED' } });
    expect(await listSignatures(svc.db.kysely, id)).toEqual([]);
  });

  it('cancels a pending signing request, but never one that was signed', async () => {
    const { app, svc } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.post(`/api/sign-intents/${intent.body.intentId}/cancel`)).status).toBe(404);
    expect((await reviewer.agent.post(`/api/sign-intents/${intent.body.intentId}/cancel`)).status).toBe(403); // CSRF gate
    const cancelled = await reviewer.post(`/api/sign-intents/${intent.body.intentId}/cancel`).expect(200);
    expect(cancelled.body).toEqual({ status: 'failed', code: 'CANCELLED', message: 'Cancelled before re-authentication finished' });
    expect((await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:sign-failed')!.output).toMatchObject({ code: 'CANCELLED' });
    expect((await readTrail(svc.db.kysely)).filter((b) => b.moduleId === 'identity:sign-failed')).toHaveLength(1);
    await reviewer.post(`/api/sign-intents/${intent.body.intentId}/cancel`).expect(200);
    expect((await readTrail(svc.db.kysely)).filter((b) => b.moduleId === 'identity:sign-failed')).toHaveLength(1);

    const r = await devSign(reviewer, 'reviewer', id, fid, 'review');
    const after = await reviewer.post(`/api/sign-intents/${r.intent.body.intentId}/cancel`).expect(200);
    expect(after.body.status).toBe('signed');
    expect((await reviewer.get(`/api/sign-intents/${r.intent.body.intentId}`)).body.status).toBe('signed');
  });

  it('records a request the app gave up on at its deadline as expired, not cancelled', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const res = await reviewer.post(`/api/sign-intents/${intent.body.intentId}/cancel`, { reason: 'expired' }).expect(200);
    expect(res.body).toMatchObject({ status: 'failed', code: 'INTENT_EXPIRED' });
    await reviewer.post(`/api/sign-intents/${intent.body.intentId}/cancel`, { reason: 'nonsense' }).expect(400);
  });

  it('serves the signing window uncached and refuses to be framed', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    for (const res of [await reviewer.get(intent.body.reauthUrl).expect(200), await reviewer.get('/auth/sign/INT-nope').expect(404)]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['content-security-policy']).toContain("script-src 'nonce-");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });
});
