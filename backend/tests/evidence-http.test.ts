import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createApp, type OpsOptions } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { loadEvidenceConfig, type EvidenceConfig } from '../src/evidence/config';
import { insertExtraction } from '../src/evidence/extraction-repo';
import { DEFAULT_RATE_LIMITS } from '../src/http/security';
import { insertDocument } from '../src/knowledge/document-repo';
import { sha256Of } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { engagementWithFailedControl, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'evidence', n));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);

async function setup(opts: { maxUploadBytes?: number; evidence?: Partial<EvidenceConfig>; ops?: OpsOptions } = {}) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const engagement = await engagementWithFailedControl(svc);
  const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'evh-')));
  const maxUploadBytes = opts.maxUploadBytes ?? 1024 * 1024;
  const evidence = { ...loadEvidenceConfig({}, { maxBytes: maxUploadBytes }), ...opts.evidence };
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes, presignDownloads: false, evidence }, opts.ops);
  const count = async () => Number((await svc.db.kysely.selectFrom('documents').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  return { svc, app, engagement, blobs, count };
}

type User = Awaited<ReturnType<typeof signIn>>;
const send = (u: User, url: string, file: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
  let r = u.agent.post(url).set('x-csrf-token', u.csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file, { filename, contentType });
};
const FIELDS = { kind: 'evidence', classification: 'internal' };

describe('evidence upload, retry and text routes', () => {
  it('uploads evidence to an engagement, extracts it and lists it with its status [REQ-38]', async () => {
    const { app, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const res = await send(auditor, `/api/engagements/${engagement.id}/evidence`, fx('sample.pdf'), 'sample.pdf', 'application/pdf', FIELDS);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: expect.stringMatching(/^DOC-/), engagementId: engagement.id, kind: 'evidence', mime: 'application/pdf', uploadedBy: 'auditor', extraction: { status: 'ok', pages: 2 }, chunks: expect.any(Number) });
    const list = await auditor.get(`/api/documents?engagementId=${engagement.id}`).expect(200);
    expect(list.body.map((d: { id: string; extraction: { status: string } }) => [d.id, d.extraction.status])).toEqual([[res.body.id, 'ok']]);
    const hits = await auditor.get(`/api/knowledge/search?q=DEV-0031&engagementId=${engagement.id}`).expect(200);
    expect(hits.body[0]).toMatchObject({ citation: { documentId: res.body.id, page: 2 } });
  });

  it('a part over the cap is 413 and nothing is stored or registered', async () => {
    const { app, engagement, blobs, count } = await setup({ maxUploadBytes: 100 });
    const auditor = await signIn(app, 'auditor');
    const big = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(200, 0x61)]);
    const res = await send(auditor, `/api/engagements/${engagement.id}/evidence`, big, 'big.pdf', 'application/pdf', FIELDS);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(await blobs.head(sha256Of(big))).toBeNull();
    expect(await count()).toBe(0);
  });

  it('declared type that contradicts the bytes is refused before storing', async () => {
    const { app, engagement, blobs, count } = await setup();
    const auditor = await signIn(app, 'auditor');
    const bytes = fx('sample.docx');
    const res = await send(auditor, `/api/engagements/${engagement.id}/evidence`, bytes, 'sample.pdf', 'application/pdf', FIELDS);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTENT_MISMATCH');
    expect(await blobs.head(sha256Of(bytes))).toBeNull();
    expect(await count()).toBe(0);
    // the sniffed mime is what is stored when the declaration is compatible
    const ok = await send(auditor, `/api/engagements/${engagement.id}/evidence`, bytes, 'sample.docx', 'application/octet-stream', FIELDS);
    expect(ok.status).toBe(201);
    expect(ok.body.mime).toBe(DOCX_MIME);
  });

  it('identical bytes on the same engagement return the existing document; a different classification is 409', async () => {
    const { app, engagement, count } = await setup();
    const auditor = await signIn(app, 'auditor');
    const url = `/api/engagements/${engagement.id}/evidence`;
    const first = await send(auditor, url, fx('sample.pdf'), 'sample.pdf', 'application/pdf', FIELDS).expect(201);
    const again = await send(auditor, url, fx('sample.pdf'), 'copy.pdf', 'application/pdf', FIELDS);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, duplicate: true });
    const differs = await send(auditor, url, fx('sample.pdf'), 'sample.pdf', 'application/pdf', { ...FIELDS, classification: 'confidential' });
    expect(differs.status).toBe(409);
    expect(differs.body).toMatchObject({ code: 'DUPLICATE_DIFFERS', existingId: first.body.id });
    expect(await count()).toBe(1);
  });

  it('a duplicate the uploader may not read is invisible and a new row is made', async () => {
    const { app, engagement, count } = await setup();
    const manager = await signIn(app, 'reviewer');
    const auditor = await signIn(app, 'auditor');
    const url = `/api/engagements/${engagement.id}/evidence`;
    const secret = await send(manager, url, fx('sample.pdf'), 'sample.pdf', 'application/pdf', { ...FIELDS, classification: 'restricted' }).expect(201);
    const mine = await send(auditor, url, fx('sample.pdf'), 'sample.pdf', 'application/pdf', FIELDS);
    expect(mine.status).toBe(201);
    expect(mine.body.id).not.toBe(secret.body.id);
    expect(await count()).toBe(2);
  });

  it('global upload needs a non-evidence kind and a preparer; viewers cannot upload', async () => {
    const { app, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const viewer = await signIn(app, 'viewer');
    const admin = await signIn(app, 'admin');
    expect((await send(auditor, '/api/documents/upload', fx('sample.pdf'), 's.pdf', 'application/pdf', FIELDS)).status).toBe(400);
    const sop = await send(auditor, '/api/documents/upload', fx('sample.pdf'), 's.pdf', 'application/pdf', { kind: 'sop', classification: 'internal' });
    expect(sop.status).toBe(201);
    expect(sop.body.engagementId).toBeNull();
    for (const u of [viewer, admin]) {
      expect((await send(u, '/api/documents/upload', fx('sample.pdf'), 's.pdf', 'application/pdf', { kind: 'sop', classification: 'internal' })).status).toBe(403);
      expect((await send(u, `/api/engagements/${engagement.id}/evidence`, fx('sample.pdf'), 's.pdf', 'application/pdf', FIELDS)).status).toBe(403);
    }
    // a classification the uploader may not read is refused
    expect((await send(auditor, `/api/engagements/${engagement.id}/evidence`, fx('sample.docx'), 's.docx', DOCX_MIME, { ...FIELDS, classification: 'restricted' })).status).toBe(403);
    // unknown engagement
    expect((await send(auditor, '/api/engagements/NOPE/evidence', fx('sample.docx'), 's.docx', DOCX_MIME, FIELDS)).status).toBe(404);
  });

  it('rejects a malformed multipart: no file, two files, a misnamed part, a bad field', async () => {
    const { app, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const url = `/api/engagements/${engagement.id}/evidence`;
    const noFile = await auditor.agent.post(url).set('x-csrf-token', auditor.csrf).field('kind', 'evidence').field('classification', 'internal');
    expect(noFile.status).toBe(400);
    const two = await auditor.agent.post(url).set('x-csrf-token', auditor.csrf).field('kind', 'evidence').field('classification', 'internal')
      .attach('file', fx('sample.pdf'), { filename: 'a.pdf', contentType: 'application/pdf' }).attach('file', fx('sample.docx'), { filename: 'b.docx', contentType: DOCX_MIME });
    expect(two.status).toBe(400);
    const misnamed = await auditor.agent.post(url).set('x-csrf-token', auditor.csrf).field('kind', 'evidence').field('classification', 'internal')
      .attach('upload', fx('sample.pdf'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(misnamed.status).toBe(400);
    expect((await send(auditor, url, fx('sample.pdf'), 'a.pdf', 'application/pdf', { ...FIELDS, kind: 'bogus' })).status).toBe(400);
    expect((await send(auditor, url, fx('sample.pdf'), 'a.pdf', 'application/pdf', { ...FIELDS, note: 'x'.repeat(501) })).status).toBe(400);
  });

  it('retry runs a new attempt only after failed or too_large', async () => {
    const { app, svc, blobs } = await setup();
    const db = svc.db.kysely;
    const auditor = await signIn(app, 'auditor');
    const viewer = await signIn(app, 'viewer');
    const bytes = fx('sample.pdf');
    await blobs.put(bytes, { mime: 'application/pdf' });
    const mk = (over: Partial<Parameters<typeof insertDocument>[1]> = {}) =>
      insertDocument(db, { sha256: sha256Of(bytes), filename: 'sample.pdf', mime: 'application/pdf', size: bytes.length, kind: 'evidence', classification: 'internal', engagementId: null, uploadedBy: 'auditor', ...over });
    const mark = (id: string, status: 'failed' | 'too_large' | 'ok') =>
      insertExtraction(db, { documentId: id, extractor: 'none', extractorVersion: '1', status, chars: 0, pages: null, error: null, by: 'auditor' });

    const failed = await mk();
    await mark(failed.id, 'failed');
    expect((await viewer.post(`/api/documents/${failed.id}/extract`)).status).toBe(403);
    const retried = await auditor.post(`/api/documents/${failed.id}/extract`);
    expect(retried.status).toBe(200);
    expect(retried.body.extraction.status).toBe('ok');
    const again = await auditor.post(`/api/documents/${failed.id}/extract`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EXTRACTION_EXISTS');

    const big = await mk();
    await mark(big.id, 'too_large');
    expect((await auditor.post(`/api/documents/${big.id}/extract`).expect(200)).body.extraction.status).toBe('ok');

    const never = await mk(); // no extraction row at all: retryable
    expect((await auditor.post(`/api/documents/${never.id}/extract`).expect(200)).body.extraction.status).toBe('ok');

    expect((await auditor.post('/api/documents/DOC-nope/extract')).status).toBe(404);
    const secret = await mk({ classification: 'restricted' });
    expect((await auditor.post(`/api/documents/${secret.id}/extract`)).status).toBe(404);

    const zip = await send(auditor, '/api/documents/upload', ZIP, 'a.zip', 'application/zip', { kind: 'sop', classification: 'internal' }).expect(201);
    expect(zip.body.extraction.status).toBe('unsupported');
    const un = await auditor.post(`/api/documents/${zip.body.id}/extract`);
    expect(un.status).toBe(409);
    expect(un.body.code).toBe('UNSUPPORTED');

    const old = await mk();
    await mark(old.id, 'failed');
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${old.id}`.execute(db);
    expect((await auditor.post(`/api/documents/${old.id}/extract`)).status).toBe(410);
  });

  it('text route serves one page or all, 404 without text, 410 when expired, same 404 when unreadable', async () => {
    const { app, svc, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const viewer = await signIn(app, 'viewer');
    const url = `/api/engagements/${engagement.id}/evidence`;
    const doc = await send(auditor, url, fx('sample.pdf'), 'sample.pdf', 'application/pdf', FIELDS).expect(201);
    const all = await auditor.get(`/api/documents/${doc.body.id}/text`).expect(200);
    expect(all.body).toMatchObject({ page: null, pages: 2 });
    expect(all.body.text).toContain('BMR-2026-0142');
    expect(all.body.text).toContain('DEV-0031');
    const p2 = await auditor.get(`/api/documents/${doc.body.id}/text?page=2`).expect(200);
    expect(p2.body).toMatchObject({ page: 2, pages: 2 });
    expect(p2.body.text).toContain('DEV-0031');
    expect(p2.body.text).not.toContain('BMR-2026-0142');
    for (const bad of ['0', '3', 'x', '-1', '1.5']) expect([bad, (await auditor.get(`/api/documents/${doc.body.id}/text?page=${bad}`)).status]).toEqual([bad, 400]);

    const scanned = await send(auditor, '/api/documents/upload', fx('scanned.pdf'), 'scan.pdf', 'application/pdf', { kind: 'sop', classification: 'internal' }).expect(201);
    expect((await auditor.get(`/api/documents/${scanned.body.id}/text`)).status).toBe(404);
    expect((await auditor.get('/api/documents/DOC-nope/text')).status).toBe(404);

    const secret = await send(await signIn(app, 'reviewer'), url, fx('sample.docx'), 's.docx', DOCX_MIME, { ...FIELDS, classification: 'restricted' }).expect(201);
    await sql`UPDATE documents SET retention_expired = true`.execute(svc.db.kysely);
    const gone = await auditor.get(`/api/documents/${doc.body.id}/text`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('RETENTION_EXPIRED');
    expect((await viewer.get(`/api/documents/${secret.body.id}/text`)).status).toBe(404);
    expect((await auditor.get(`/api/documents/${secret.body.id}/text`)).status).toBe(404);
  });

  it('uploads are rate limited [REQ-38]', async () => {
    const { app, engagement } = await setup({ ops: { rateLimits: { ...DEFAULT_RATE_LIMITS, uploadsPerMinute: 2 } } });
    const auditor = await signIn(app, 'auditor');
    const url = `/api/engagements/${engagement.id}/evidence`;
    await send(auditor, url, fx('sample.pdf'), 'a.pdf', 'application/pdf', FIELDS).expect(201);
    await send(auditor, url, fx('sample.docx'), 'a.docx', DOCX_MIME, FIELDS).expect(201);
    const third = await send(auditor, url, fx('sample.xlsx'), 'a.xlsx', 'application/octet-stream', FIELDS);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
  });

  it('a note is stored in metadata and retainUntil defaults from EVIDENCE_RETENTION_YEARS', async () => {
    const { app, engagement } = await setup({ evidence: { retentionYears: 2 } });
    const auditor = await signIn(app, 'auditor');
    const url = `/api/engagements/${engagement.id}/evidence`;
    const now = new Date();
    const expected = `${now.getUTCFullYear() + 2}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const res = await send(auditor, url, fx('sample.pdf'), 'a.pdf', 'application/pdf', { ...FIELDS, note: 'walkthrough photo' }).expect(201);
    expect(res.body.metadata).toEqual({ note: 'walkthrough photo' });
    expect(res.body.retainUntil).toBe(expected);
    const explicit = await send(auditor, url, fx('sample.docx'), 'a.docx', DOCX_MIME, { ...FIELDS, retainUntil: '2040-01-31' }).expect(201);
    expect(explicit.body.retainUntil).toBe('2040-01-31');
    expect((await send(auditor, url, fx('sample.xlsx'), 'a.xlsx', 'application/octet-stream', { ...FIELDS, retainUntil: '2020-01-01' })).status).toBe(400);
    expect((await send(auditor, url, fx('sample.xlsx'), 'a.xlsx', 'application/octet-stream', { ...FIELDS, retainUntil: '2026-02-30' })).status).toBe(400);
  });
});
