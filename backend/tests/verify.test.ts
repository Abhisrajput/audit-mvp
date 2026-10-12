import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { insertDocument } from '../src/knowledge/document-repo';
import { verifyIntegrity } from '../src/ops/verify';
import { AuditService } from '../src/service';
import { blobKey } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { ensureDevUsers } from '../src/auth/dev-users';
import { testDbWithUrl } from './db';
import { approver, auditor, engagementWithFailedControl, LENIENT, registry, reviewer, unattended } from './helpers';

/** A database with an approved, signed finding and two stored documents, and the local store holding their bytes. */
async function restoredSystem() {
  const { db, url } = await testDbWithUrl();
  const svc = new AuditService(db, registry, null, LENIENT);
  await ensureDevUsers(db.kysely);
  const e = await engagementWithFailedControl(svc);
  const fid = e.findings[0].id;
  await svc.signOff(e.id, fid, 'review', 'ok', reviewer, {}, unattended);
  await svc.signOff(e.id, fid, 'approve', 'ok', approver, {}, unattended);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-blobs-'));
  const blobs = new LocalBlobStore(dir);
  const docs = [];
  for (const text of ['SOP-001 cleaning procedure', 'Batch record template']) {
    const stored = await blobs.put(Buffer.from(text));
    docs.push(await insertDocument(db.kysely, {
      sha256: stored.sha256, filename: `${text}.txt`, mime: 'text/plain', size: stored.size, kind: 'sop',
      classification: 'internal', engagementId: null, uploadedBy: auditor.id,
    }));
  }
  return { db, url, dir, blobs, engagementId: e.id, fid, docs };
}

describe('verify', () => {
  it('passes a database whose trail, signatures and stored files are intact [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(true);
    expect(report.trail.valid).toBe(true);
    expect(report.signatures).toEqual({ checked: 2, problems: [] });
    expect(report.documents).toEqual({ checked: 2, problems: [], skipped: null });
  });

  it('reports a stored file that is missing or whose bytes changed [REQ-24]', async () => {
    const s = await restoredSystem();
    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    fs.writeFileSync(path.join(s.dir, blobKey(s.docs[1].sha256)), 'tampered bytes');
    const report = await verifyIntegrity(s.db.kysely, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.documents.problems).toEqual([
      `Document ${s.docs[0].id}: stored file ${s.docs[0].sha256} is missing`,
      expect.stringMatching(new RegExp(`^Document ${s.docs[1].id}: stored bytes hash to [a-f0-9]{64}, not ${s.docs[1].sha256}`)),
    ]);
  });

  it('reports a signature rewritten behind the application, and a trail entry edited after the fact [REQ-24]', async () => {
    const s = await restoredSystem();
    const k = s.db.kysely;
    const sig = await k.selectFrom('signatures').select('id').where('meaning', '=', 'Approved').executeTakeFirstOrThrow();
    await sql`ALTER TABLE signatures DISABLE TRIGGER signatures_append_only`.execute(k);
    await sql`UPDATE signatures SET content_hash = ${'f'.repeat(64)} WHERE id = ${sig.id}`.execute(k);
    await sql`ALTER TABLE trail DISABLE TRIGGER trail_append_only`.execute(k);
    await sql`UPDATE trail SET body = replace(body, 'Plant 1', 'Plant 9') WHERE module_id = 'human:create-engagement'`.execute(k);

    const report = await verifyIntegrity(k, s.blobs);
    expect(report.ok).toBe(false);
    expect(report.trail).toMatchObject({ valid: false, brokenAt: 1 });
    expect(report.signatures.problems).toEqual(expect.arrayContaining([
      `Signature ${sig.id} (finding ${s.fid}): the signed content is not in the finding's history`,
      `Signature ${sig.id} (finding ${s.fid}): does not match its trail entry`,
      expect.stringMatching(new RegExp(`^Finding ${s.fid} in ${s.engagementId}: sign-off ${sig.id} \\(Approved by .+\\) is broken`)),
    ]));
  });

  it('prints one JSON report and exits 1 when anything is wrong [REQ-24]', async () => {
    const s = await restoredSystem();
    const run = () => spawnSync('npx', ['tsx', 'src/db/cli.ts', 'verify'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: s.url, BLOB_DRIVER: 'local', BLOB_LOCAL_DIR: s.dir, LOG_LEVEL: 'silent' },
    });
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, documents: { checked: 2 } });

    fs.rmSync(path.join(s.dir, blobKey(s.docs[0].sha256)));
    const broken = run();
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).documents.problems).toHaveLength(1);
  }, 60_000);

  it('fails rather than passes when it cannot look at the stored files [REQ-24]', async () => {
    const s = await restoredSystem();
    const report = await verifyIntegrity(s.db.kysely, null, 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3');
    expect(report.ok).toBe(false);
    expect(report.documents).toEqual({ checked: 0, problems: [], skipped: 'file storage is not configured: S3_BUCKET is required when BLOB_DRIVER=s3' });
  });
});
