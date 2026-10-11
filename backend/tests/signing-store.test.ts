import { describe, expect, it } from 'vitest';
import { listRevisions } from '../src/db/revision-repo';
import { insertSignature, listSignatures, type SignatureRow } from '../src/db/signature-repo';
import type { Finding } from '../src/engine/types';
import { findingContentHash, withSignatureStatus } from '../src/signing/content-hash';
import { auditor, engagementWithFailedControl, newService } from './helpers';

describe('finding content hash', () => {
  it('covers what the finding says, not its key order, status or sign-offs', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    const h = findingContentHash(f);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(findingContentHash(Object.fromEntries(Object.entries(f).reverse()) as Finding)).toBe(h);
    expect(findingContentHash({ ...f, status: 'reviewed', signOffs: [], preparedBy: ['someone'] })).toBe(h);
    expect(findingContentHash({ ...f, condition: `${f.condition}!` })).not.toBe(h);
    expect(findingContentHash({ ...f, evidenceRefs: [...f.evidenceRefs, 'EXTRA'] })).not.toBe(h);
  });

  it('flags a sign-off whose content no longer matches as broken, without touching the original', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    const good = { userId: 'r', userName: 'R', role: 'audit_manager', meaning: 'Reviewed' as const, comment: '', at: '2026-10-11T00:00:00.000Z', contentHash: findingContentHash(f) };
    const bad = { ...good, contentHash: 'b'.repeat(64) };
    const legacy = { userId: 'x', userName: 'X', role: 'reviewer', meaning: 'Reviewed' as const, comment: '', at: '2026-01-01T00:00:00.000Z' };
    const shown = withSignatureStatus({ ...e, findings: [{ ...f, signOffs: [good, bad, legacy] }] });
    expect(shown.findings[0].signOffs.map((s) => s.broken)).toEqual([false, true, undefined]);
    expect(e.findings[0].signOffs).toEqual([]);
  });
});

describe('finding revisions', () => {
  it('records a revision when a finding is drafted and whenever its content changes', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const f = e.findings[0];
    const db = svc.db.kysely;
    expect((await listRevisions(db, e.id, f.id)).map((r) => r.revision)).toEqual([1]);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, auditor);
    await svc.editFinding(e.id, f.id, { title: 'Roaster CCP logs unsigned' }, auditor); // same content: no new revision
    const revisions = await listRevisions(db, e.id, f.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[1].contentHash).toBe(findingContentHash((await svc.engagement(e.id)).findings[0]));
    await expect(db.deleteFrom('finding_revisions').execute()).rejects.toThrow(/append-only: DELETE/);
  });
});

describe('signatures table', () => {
  it('stores signatures and refuses to change or delete them [REQ-20]', async () => {
    const svc = await newService();
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const row: SignatureRow = {
      id: 'SIG-1', engagementId: e.id, findingId: e.findings[0].id, userId: 'reviewer', userName: 'Ravi Reviewer', role: 'audit_manager',
      meaning: 'Reviewed', comment: '', contentHash: 'a'.repeat(64), reauthMethod: 'dev', reauthAt: '2026-10-11T00:00:00.000Z',
      intentId: null, trailBundleId: 'HUM-1', signedAt: '2026-10-11T00:00:01.000Z',
    };
    await insertSignature(db, row);
    expect(await listSignatures(db, e.id)).toEqual([row]);
    await expect(db.updateTable('signatures').set({ comment: 'x' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('signatures').execute()).rejects.toThrow(/append-only: DELETE/);
  });
});
