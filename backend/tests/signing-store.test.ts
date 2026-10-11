import { sql } from 'kysely';
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

  it('checks each signed sign-off against its append-only signature row; unsigned ones are legacy [REQ-19]', async () => {
    const e = await engagementWithFailedControl(await newService());
    const f = e.findings[0];
    const hash = findingContentHash(f);
    const base = { userId: 'r', userName: 'R', role: 'audit_manager', meaning: 'Reviewed' as const, comment: '', at: '2026-10-11T00:00:00.000Z', reauth: { method: 'dev' as const, at: '2026-10-11T00:00:00.000Z' } };
    const row = (id: string, contentHash: string, extra: Partial<SignatureRow> = {}): SignatureRow => ({
      id, engagementId: e.id, findingId: f.id, userId: 'r', userName: 'R', role: 'audit_manager', meaning: 'Reviewed', comment: '', contentHash,
      reauthMethod: 'dev', reauthAt: base.reauth.at, intentId: null, trailBundleId: 'HUM-1', signedAt: base.at, ...extra,
    });
    const good = { ...base, signatureId: 'SIG-good', contentHash: hash };
    const changed = { ...base, signatureId: 'SIG-changed', contentHash: 'b'.repeat(64) };
    const noRow = { ...base, signatureId: 'SIG-missing', contentHash: hash };
    const rewritten = { ...base, signatureId: 'SIG-rewritten', contentHash: hash }; // JSONB rewritten to match; the row still has the original
    const otherSigner = { ...base, signatureId: 'SIG-other', contentHash: hash };
    const legacy = { ...base, userId: 'imported', reauth: { method: 'oidc' as const, at: base.at } }; // imported, pre-Part 11: no signature id and no record
    const rows = [row('SIG-good', hash), row('SIG-changed', 'b'.repeat(64)), row('SIG-rewritten', 'c'.repeat(64)), row('SIG-other', hash, { userId: 'x' })];
    const shown = withSignatureStatus({ ...e, findings: [{ ...f, signOffs: [good, changed, noRow, rewritten, otherSigner, legacy] }] }, rows, new Map());
    expect(shown.findings[0].signOffs.map((s) => [s.broken, s.legacy])).toEqual([
      [false, false], [true, false], [true, false], [true, false], [true, false], [false, true],
    ]);
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
    await expect(sql`TRUNCATE signatures`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
  });
});
