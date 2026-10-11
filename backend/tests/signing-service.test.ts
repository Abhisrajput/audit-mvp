import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { findingContentHash } from '../src/signing/content-hash';
import { failIntent } from '../src/signing/flow';
import { claimIntent, createIntent, finishIntent, getIntent } from '../src/signing/intent-repo';
import type { AuditService, SignAction } from '../src/service';
import type { Engagement, User } from '../src/engine/types';
import { approver, auditor, engagementWithFailedControl, newService, reviewer, unattended } from './helpers';
import { failTrailWrites } from './http';

const reauth = (contentHash: string, intentId: string) => ({ contentHash, reauthMethod: 'dev' as const, reauthAt: '2026-10-11T09:00:00.000Z', intentId });

/** A real signing request for the first finding, claimed as completeSigning would claim it. */
async function claimedIntent(svc: AuditService, e: Engagement, user: User, action: SignAction = 'review', claim = true) {
  await ensureDevUsers(svc.db.kysely);
  const f = e.findings[0];
  const intent = await createIntent(svc.db.kysely, { userId: user.id, engagementId: e.id, findingId: f.id, action, comment: '', contentHash: findingContentHash(f) });
  if (claim) expect(await claimIntent(svc.db.kysely, intent.id)).toBe(true);
  return intent;
}

describe('signatures written by the service', () => {
  it('binds each sign-off to the exact content signed and records it in the signatures table [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const hash = findingContentHash(f);
    const intent = await claimedIntent(svc, e, reviewer);
    const reviewed = await svc.signOff(e.id, f.id, 'review', 'agreed', reviewer, {}, reauth(hash, intent.id));
    const s = reviewed.signOffs[0];
    expect(s).toMatchObject({
      userId: 'reviewer', userName: 'Ravi Reviewer', role: 'audit_manager', meaning: 'Reviewed', comment: 'agreed',
      contentHash: hash, reauth: { method: 'dev', at: '2026-10-11T09:00:00.000Z' },
    });
    expect(s.signatureId).toMatch(/^SIG-[0-9a-f]{12}$/);
    const [row] = await listSignatures(svc.db.kysely, e.id);
    const bundle = (await readTrail(svc.db.kysely, e.id)).at(-1)!;
    expect(bundle.moduleId).toBe('human:sign-off');
    expect(row).toMatchObject({
      id: s.signatureId, findingId: f.id, userId: 'reviewer', meaning: 'Reviewed', contentHash: hash,
      reauthMethod: 'dev', reauthAt: '2026-10-11T09:00:00.000Z', intentId: intent.id, trailBundleId: bundle.id,
    });
  });

  it('records server-side signing without re-authentication as such', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = await svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer, {}, unattended);
    expect(f.signOffs[0].reauth).toEqual({ method: 'none', at: null });
    expect((await listSignatures(svc.db.kysely, e.id))[0]).toMatchObject({ reauthMethod: 'none', reauthAt: null, intentId: null });
    expect((await readTrail(svc.db.kysely, e.id)).at(-1)!.inputs).toMatchObject({ intentId: null, unattended: 'test' });
  });

  it('fails closed when called without a signature context [REQ-18]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    // @ts-expect-error the signature context is required
    await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer)).rejects.toMatchObject({ status: 428, code: 'REAUTH_REQUIRED' });
    await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer, {}, undefined as never)).rejects.toMatchObject({ status: 428, code: 'REAUTH_REQUIRED' });
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
    expect((await svc.engagement(e.id)).findings[0].status).toBe('draft');
  });

  it('marks the signing request signed in the same transaction as the signature', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const hash = findingContentHash(f);
    const db = svc.db.kysely;
    const intent = await createIntent(db, { userId: 'reviewer', engagementId: e.id, findingId: f.id, action: 'review', comment: '', contentHash: hash });
    expect(await claimIntent(db, intent.id)).toBe(true);
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(hash, intent.id));
    expect((await getIntent(db, intent.id))!.status).toBe('signed');

    // When the signature rolls back, so does the request's 'signed' mark.
    const g = await engagementWithFailedControl(svc);
    const other = await createIntent(db, { userId: 'reviewer', engagementId: g.id, findingId: g.findings[0].id, action: 'review', comment: '', contentHash: findingContentHash(g.findings[0]) });
    await claimIntent(db, other.id);
    await failTrailWrites(svc.db, ['human:sign-off']);
    await expect(svc.signOff(g.id, g.findings[0].id, 'review', '', reviewer, {}, reauth(findingContentHash(g.findings[0]), other.id))).rejects.toThrow(/trail unavailable/);
    expect((await getIntent(db, other.id))!.status).toBe('claimed');
  });

  it('refuses to sign content that changed after the signing request, writing nothing [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const stale = findingContentHash(f);
    const intent = await claimedIntent(svc, e, reviewer);
    await svc.editFinding(e.id, f.id, { condition: 'Four of twenty logs unsigned.' }, auditor);
    const before = await svc.engagement(e.id);
    const trailBefore = await readTrail(svc.db.kysely, e.id);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(stale, intent.id))).rejects.toMatchObject({ status: 409, code: 'CONTENT_CHANGED' });
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
    const after = await svc.engagement(e.id);
    expect(after.findings[0].status).toBe(before.findings[0].status);
    expect(after.findings[0].signOffs).toEqual([]);
    expect(after.version).toBe(before.version);
    const trailAfter = await readTrail(svc.db.kysely, e.id);
    expect(trailAfter).toHaveLength(trailBefore.length);
    expect(trailAfter.some((b) => b.moduleId === 'human:sign-off')).toBe(false);
  });

  it('writes no signature when the sign-off cannot be trailed', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await failTrailWrites(svc.db, ['human:sign-off']);
    await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer, {}, unattended)).rejects.toThrow(/trail unavailable/);
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
    expect((await svc.engagement(e.id)).findings[0].status).toBe('draft');
  });

  it('checks who may sign before any re-authentication starts [REQ-17]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await expect(svc.checkSignOff(e.id, f.id, 'review', reviewer)).resolves.toEqual({ contentHash: findingContentHash(f) });
    await expect(svc.checkSignOff(e.id, f.id, 'review', auditor)).rejects.toMatchObject({ status: 403 });
    await expect(svc.checkSignOff(e.id, f.id, 'approve', approver)).rejects.toThrow(/reviewed before/);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, reviewer);
    await expect(svc.checkSignOff(e.id, f.id, 'review', reviewer)).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
    await expect(svc.checkSignOff(e.id, 'F-NOPE', 'review', reviewer)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a signature whose signing request is not claimed, writing nothing', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const pending = await claimedIntent(svc, e, reviewer, 'review', false);
    const failed = await claimedIntent(svc, e, reviewer, 'review', false);
    await finishIntent(svc.db.kysely, failed.id, { status: 'failed', code: 'REAUTH_REQUIRED', message: 'x' });
    const trailBefore = await readTrail(svc.db.kysely, e.id);
    for (const intent of [pending, failed]) {
      await expect(svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(findingContentHash(f), intent.id)))
        .rejects.toMatchObject({ status: 409, code: 'INTENT_EXPIRED' });
    }
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
    const after = await svc.engagement(e.id);
    expect(after.findings[0]).toMatchObject({ status: 'draft', signOffs: [] });
    expect(after.version).toBe(e.version);
    expect(await readTrail(svc.db.kysely, e.id)).toHaveLength(trailBefore.length);
    expect((await getIntent(svc.db.kysely, pending.id))!.status).toBe('pending');
    expect((await getIntent(svc.db.kysely, failed.id))!.status).toBe('failed');
  });

  it('never fails a request another attempt has claimed; the late failure is trailed as a replay [REQ-18]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const db = svc.db.kysely;
    const intent = await claimedIntent(svc, e, reviewer, 'review', false);
    // A failing callback read the request while it was pending ...
    const seenPending = { ...intent };
    // ... and meanwhile the other attempt claimed it.
    expect(await claimIntent(db, intent.id)).toBe(true);
    const before = (await readTrail(db)).filter((b) => b.moduleId === 'identity:sign-failed').length;
    const out = await failIntent(svc, seenPending, reviewer, 'REAUTH_USER_MISMATCH', 'You re-authenticated as a different person.');
    expect(out).toMatchObject({ ok: false, code: 'REAUTH_USER_MISMATCH' });
    expect((await getIntent(db, intent.id))!.status).toBe('claimed');
    const entries = (await readTrail(db)).filter((b) => b.moduleId === 'identity:sign-failed').slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0].output).toMatchObject({ code: 'REAUTH_USER_MISMATCH', replay: true, intentStatus: 'claimed' });

    // The attempt that claimed it completes the signature.
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(findingContentHash(f), intent.id));
    expect((await getIntent(db, intent.id))!.status).toBe('signed');
    expect(await listSignatures(db, e.id)).toHaveLength(1);
  });

  it('shows the manifestation from the signature record, not the editable finding [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    const [row] = await listSignatures(svc.db.kysely, e.id);
    const forged = { method: 'oidc', at: '2026-10-11T09:00:00.000Z' };
    await sql`UPDATE findings SET data = jsonb_set(jsonb_set(jsonb_set(data, '{signOffs,0,reauth}', ${JSON.stringify(forged)}::jsonb), '{signOffs,0,userName}', '"Someone Else"'), '{signOffs,0,at}', '"2020-01-01T00:00:00.000Z"') WHERE id = ${f.id}`.execute(svc.db.kysely);
    const s = (await svc.engagementWithSignatureStatus(e.id)).findings[0].signOffs[0];
    expect(s).toMatchObject({ reauth: { method: 'none', at: null }, userName: 'Ravi Reviewer', role: 'audit_manager', meaning: 'Reviewed', at: row.signedAt, signatureId: row.id });
    // The stored finding keeps what was written; only the response copy is corrected.
    expect((await svc.engagement(e.id)).findings[0].signOffs[0].reauth).toEqual(forged);
  });

  it('shows the recorded signer on a sign-off whose signer was rewritten, and marks it broken [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    const [row] = await listSignatures(svc.db.kysely, e.id);
    await sql`UPDATE findings SET data = jsonb_set(jsonb_set(jsonb_set(data, '{signOffs,0,userId}', '"approver"'), '{signOffs,0,userName}', '"Priya QA Head"'), '{signOffs,0,role}', '"cae"') WHERE id = ${f.id}`.execute(svc.db.kysely);
    const shown = (await svc.engagementWithSignatureStatus(e.id)).findings[0];
    expect(shown.signOffs[0]).toMatchObject({ broken: true, legacy: false, userName: 'Ravi Reviewer', role: 'audit_manager', signatureId: row.id, at: row.signedAt });
    expect(shown.signatureIssues).toBeUndefined();
  });

  it('treats a save that changes nothing as no edit: the finding keeps its status and signature', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    const before = await svc.engagement(e.id);
    const trailBefore = await readTrail(svc.db.kysely, e.id);
    const { title, condition, evidenceRefs } = before.findings[0];
    const same = await svc.editFinding(e.id, f.id, { title, condition, evidenceRefs: [...evidenceRefs] }, auditor);
    expect(same).toMatchObject({ status: 'reviewed', signOffs: [expect.objectContaining({ meaning: 'Reviewed' })] });
    const after = await svc.engagement(e.id);
    expect(after.findings[0]).toEqual(before.findings[0]);
    expect(after.version).toBe(before.version);
    expect(await readTrail(svc.db.kysely, e.id)).toHaveLength(trailBefore.length);
    expect((await svc.engagementWithSignatureStatus(e.id)).findings[0].signatureIssues).toBeUndefined();
    // A real change still resets the sign-offs.
    expect(await svc.editFinding(e.id, f.id, { condition: 'Four of twenty logs unsigned.' }, auditor)).toMatchObject({ status: 'draft', signOffs: [] });
  });

  it('reports no signature issue after content is changed and changed back (the signature predates both edits)', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    await svc.signOff(e.id, f.id, 'review', '', reviewer, {}, unattended);
    await svc.editFinding(e.id, f.id, { condition: 'Four of twenty logs unsigned.' }, auditor);
    await svc.editFinding(e.id, f.id, { condition: f.condition }, auditor);
    const shown = (await svc.engagementWithSignatureStatus(e.id)).findings[0];
    expect(findingContentHash(shown)).toBe(findingContentHash(f));
    expect(shown.signOffs).toEqual([]);
    expect(shown.signatureIssues).toBeUndefined();
  });
});
