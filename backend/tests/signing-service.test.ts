import { describe, expect, it } from 'vitest';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import { findingContentHash } from '../src/signing/content-hash';
import { approver, auditor, engagementWithFailedControl, newService, reviewer } from './helpers';
import { failTrailWrites } from './http';

const reauth = (contentHash: string, intentId = 'INT-1') => ({ contentHash, reauthMethod: 'dev' as const, reauthAt: '2026-10-11T09:00:00.000Z', intentId });

describe('signatures written by the service', () => {
  it('binds each sign-off to the exact content signed and records it in the signatures table [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const hash = findingContentHash(f);
    const reviewed = await svc.signOff(e.id, f.id, 'review', 'agreed', reviewer, {}, reauth(hash));
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
      reauthMethod: 'dev', reauthAt: '2026-10-11T09:00:00.000Z', intentId: 'INT-1', trailBundleId: bundle.id,
    });
  });

  it('records server-side signing without re-authentication as such', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = await svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer);
    expect(f.signOffs[0].reauth).toEqual({ method: 'none', at: null });
    expect((await listSignatures(svc.db.kysely, e.id))[0]).toMatchObject({ reauthMethod: 'none', reauthAt: null, intentId: null });
  });

  it('refuses to sign content that changed after the signing request, writing nothing [REQ-19]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const stale = findingContentHash(f);
    await svc.editFinding(e.id, f.id, { condition: 'Four of twenty logs unsigned.' }, auditor);
    await expect(svc.signOff(e.id, f.id, 'review', '', reviewer, {}, reauth(stale, 'INT-2'))).rejects.toMatchObject({ status: 409, code: 'CONTENT_CHANGED' });
    expect(await listSignatures(svc.db.kysely, e.id)).toEqual([]);
  });

  it('writes no signature when the sign-off cannot be trailed', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    await failTrailWrites(svc.db, ['human:sign-off']);
    await expect(svc.signOff(e.id, e.findings[0].id, 'review', '', reviewer)).rejects.toThrow(/trail unavailable/);
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
});
