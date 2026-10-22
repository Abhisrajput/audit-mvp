import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { blobKey, sha256Of, type BlobStore } from '../src/storage/blob-store';
import { Readable } from 'node:stream';
import { sql } from 'kysely';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { captureLogs } from '../src/observability/log';
import { engagementWithFailedControl, NEW_ENGAGEMENT, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

async function setup(opts: { blobs?: boolean | ((local: LocalBlobStore) => BlobStore); maxUploadBytes?: number; presignDownloads?: boolean } = {}) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const engagement = await engagementWithFailedControl(svc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  const local = new LocalBlobStore(dir);
  const blobs = opts.blobs === false ? null : typeof opts.blobs === 'function' ? opts.blobs(local) : local;
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: opts.maxUploadBytes ?? 1024 * 1024, presignDownloads: opts.presignDownloads ?? false });
  return { svc, app, engagement, dir };
}

/** A store that behaves like the local one except where overridden. */
const fakeStore = (local: LocalBlobStore, over: Partial<BlobStore>): BlobStore => ({
  driver: 's3',
  put: (b, m) => local.put(b),
  get: (sha) => local.get(sha),
  head: (sha) => local.head(sha),
  presignedGet: async () => null,
  ...over,
});

const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const parts: Buffer[] = [];
  r.on('data', (c: Buffer) => parts.push(c));
  r.on('end', () => cb(null, Buffer.concat(parts)));
};

const SOP = Buffer.from('%PDF-1.4 fake pdf bytes for SOP-ALG-004');

function upload(user: Awaited<ReturnType<typeof signIn>>, bytes: Buffer) {
  return user.agent.put('/api/blobs').set('x-csrf-token', user.csrf).set('Content-Type', 'application/pdf').send(bytes);
}

describe('document API', () => {
  it('uploads a file once, registers it with its text, and finds it in search', async () => {
    const { app, svc, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    expect(up.body).toEqual({ sha256: sha256Of(SOP), size: SOP.length });
    expect((await upload(auditor, SOP).expect(201)).body).toEqual(up.body);

    const reg = await auditor.post('/api/documents', {
      sha256: up.body.sha256, filename: 'SOP-ALG-004.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal',
      engagementId: engagement.id, text: { content: 'Changeover cleaning on the hazelnut line must be verified by allergen swab.', pageStarts: [0] },
    }).expect(201);
    expect(reg.body).toMatchObject({ id: expect.stringMatching(/^DOC-/), size: SOP.length, uploadedBy: 'auditor', engagementId: engagement.id, chunks: 1 });

    const hits = await auditor.get(`/api/knowledge/search?q=${encodeURIComponent('allergen swab')}&engagementId=${engagement.id}`).expect(200);
    expect(hits.body[0]).toMatchObject({ citation: { documentId: reg.body.id, filename: 'SOP-ALG-004.pdf', page: 1 } });
    expect((await auditor.get('/api/knowledge/search?q=allergen').expect(200)).body).toEqual([]); // engagement documents need the engagement

    const trail = (await readTrail(svc.db.kysely, engagement.id)).at(-1)!;
    expect(trail).toMatchObject({ moduleId: 'document:register', actor: 'auditor', engagementId: engagement.id, inputs: { documentId: reg.body.id, sha256: up.body.sha256 }, output: { chunks: 1 } });
    expect(trail.inputs).not.toHaveProperty('filename');
    expect(trail.id).toMatch(/^DOC-EVT-[0-9a-f]{16}$/);
  });

  it('still answers 201 when extraction throws after the registration committed', async () => {
    const { app } = await setup({ blobs: (local) => fakeStore(local, { get: async () => { throw new Error('storage went away'); } }) });
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' });
    expect(reg.status).toBe(201);
    expect(reg.body.extraction === null || reg.body.extraction.status === 'failed').toBe(true);
    expect(reg.body.chunks).toBe(0);
  });

  it('serves the exact bytes back, as a download that cannot be sniffed', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'SOP "ALG"\r\n.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
    // No text supplied: the server extracts. These fake %PDF- bytes sniff as a pdf and cannot be parsed.
    expect(['no_text', 'failed']).toContain(reg.body.extraction.status);
    expect(reg.body.chunks).toBe(0);
    const res = await auditor.get(`/api/documents/${reg.body.id}/content`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    expect(res.body).toEqual(SOP);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n"]ALG/);
  });

  it('answers 404 for a document the reader may not see, exactly as for one that does not exist [REQ-23]', async () => {
    const { app } = await setup();
    const manager = await signIn(app, 'reviewer');
    const up = await upload(manager, SOP).expect(201);
    const reg = await manager.post('/api/documents', { sha256: up.body.sha256, filename: 'incident.pdf', mime: 'application/pdf', kind: 'other', classification: 'restricted', text: { content: 'Restricted incident review.' } }).expect(201);
    const viewer = await signIn(app, 'viewer');
    for (const p of [`/api/documents/${reg.body.id}`, `/api/documents/${reg.body.id}/content`, '/api/documents/DOC-000000000000', '/api/documents/DOC-000000000000/content']) {
      const res = await viewer.get(p);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Document not found');
    }
    expect((await viewer.get('/api/documents').expect(200)).body).toEqual([]);
    expect((await viewer.get('/api/knowledge/search?q=incident').expect(200)).body).toEqual([]);
  });

  it('redacts trail entries for documents the reader may not see, keeping their place in the chain [REQ-23]', async () => {
    const { app } = await setup();
    const manager = await signIn(app, 'reviewer');
    const created = await manager.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
    const engagementId = created.body.id as string;
    const up = await upload(manager, Buffer.from('%PDF restricted incident'));
    await manager.post('/api/documents', {
      sha256: up.body.sha256, filename: 'incident.pdf', mime: 'application/pdf', kind: 'other', classification: 'restricted', engagementId,
    }).expect(201);

    const full = (await manager.get(`/api/engagements/${engagementId}/trail`).expect(200)).body;
    const shown = full.find((b: any) => b.moduleId === 'document:register');
    expect(shown.inputs).toMatchObject({ classification: 'restricted', sha256: up.body.sha256 });
    expect(shown.redacted).toBeUndefined();

    const viewer = await signIn(app, 'viewer');
    const limited = (await viewer.get(`/api/engagements/${engagementId}/trail`).expect(200)).body;
    const hidden = limited.find((b: any) => b.moduleId === 'document:register');
    expect(hidden).toMatchObject({ id: shown.id, seq: shown.seq, hash: shown.hash, prevHash: shown.prevHash, actor: shown.actor, redacted: true, inputs: { classification: 'restricted' }, output: null, executionLog: [] });
    expect(JSON.stringify(limited)).not.toContain(up.body.sha256);
    expect(limited.map((b: any) => b.seq)).toEqual(full.map((b: any) => b.seq));
  });

  it('refuses registrations that are wrong, unknown or beyond what the uploader may read', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const base = { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' };
    expect((await auditor.post('/api/documents', { ...base, sha256: 'f'.repeat(64) })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, sha256: '../../etc/passwd' })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, kind: 'invoice' })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, engagementId: 'ENG-NOPE' })).status).toBe(404);
    expect((await auditor.post('/api/documents', { ...base, classification: 'restricted' })).status).toBe(403);
    const viewer = await signIn(app, 'viewer');
    expect((await upload(viewer, SOP)).status).toBe(403);
    expect((await viewer.post('/api/documents', base)).status).toBe(403);
    expect((await auditor.get('/api/documents/x/../../etc/passwd')).status).toBe(404);
  });

  it('does not let someone register bytes they never uploaded, even knowing the hash', async () => {
    const { app, svc } = await setup();
    const a = await signIn(app, 'reviewer');
    const up = await upload(a, SOP).expect(201);
    await a.post('/api/documents', { sha256: up.body.sha256, filename: 'incident.pdf', mime: 'application/pdf', kind: 'other', classification: 'restricted' }).expect(201);
    const b = await signIn(app, 'auditor');
    const base = { sha256: up.body.sha256, filename: 'mine.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' };
    const res = await b.post('/api/documents', base);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Upload the file first: no stored object has that SHA-256');
    expect((await svc.db.kysely.selectFrom('documents').select('id').execute()).length).toBe(1);
    await upload(b, SOP).expect(201);
    await b.post('/api/documents', base).expect(201);
    expect((await svc.db.kysely.selectFrom('documents').select('id').execute()).length).toBe(2);
  });

  it('refuses oversized uploads and reports missing storage plainly', async () => {
    const small = await setup({ maxUploadBytes: 16 });
    const a = await signIn(small.app, 'auditor');
    expect((await upload(a, SOP)).status).toBe(413);
    const none = await setup({ blobs: false });
    const b = await signIn(none.app, 'auditor');
    const res = await upload(b, SOP);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('stores JSON files byte for byte, valid or not, and accepts large registrations', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    for (const raw of ['{"ledger": [1, 2, 3]}', '{"broken": ']) {
      const bytes = Buffer.from(raw);
      const res = await auditor.agent.put('/api/blobs').set('x-csrf-token', auditor.csrf).set('Content-Type', 'application/json').send(raw).expect(201);
      expect(res.body).toEqual({ sha256: sha256Of(bytes), size: bytes.length });
    }
    // A registration with ~1.8 MB of text: beyond the global 1 MB JSON limit, within the route's own.
    const up = await upload(auditor, SOP).expect(201);
    const content = 'é'.repeat(899_000);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'big.txt', mime: 'text/plain', kind: 'other', classification: 'internal', text: { content } });
    expect(reg.status).toBe(201);
    // Other routes keep the 1 MB limit and say so generically.
    const tooBig = await auditor.post('/api/engagements', { name: 'x'.repeat(1_100_000) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toEqual({ error: 'The request body is larger than the limit', code: 'VALIDATION', requestId: tooBig.headers['x-request-id'] });
  });

  it('serves active content types as inert downloads with a sandboxing CSP and a UTF-8 filename', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const html = Buffer.from('<script>alert(document.cookie)</script>');
    const up = await upload(auditor, html).expect(201);
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/javascript']) {
      const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'Prüfbericht (final).html', mime, kind: 'other', classification: 'internal' }).expect(201);
      const res = await auditor.get(`/api/documents/${reg.body.id}/content`).buffer(true).parse(binary).expect(200);
      expect(res.body).toEqual(html);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="Pr_fbericht _final_.html"; filename*=UTF-8''Pr%C3%BCfbericht%20%28final%29.html`);
    }
    for (const mime of ['text/html; charset=utf-8', '<script>', 'pdf', 'a/b/c', `${'a'.repeat(150)}/${'b'.repeat(60)}`]) {
      expect((await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'x', mime, kind: 'other', classification: 'internal' })).status).toBe(400);
    }
  });

  it('keeps expired documents listed but refuses their content with 410, after the read check [REQ-23]', async () => {
    const { app, svc } = await setup();
    const manager = await signIn(app, 'reviewer');
    const up = await upload(manager, SOP).expect(201);
    const open = await manager.post('/api/documents', { sha256: up.body.sha256, filename: 'old.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
    const secret = await manager.post('/api/documents', { sha256: up.body.sha256, filename: 'old-secret.pdf', mime: 'application/pdf', kind: 'sop', classification: 'restricted' }).expect(201);
    await sql`UPDATE documents SET retention_expired = true`.execute(svc.db.kysely);

    expect((await manager.get('/api/documents').expect(200)).body.map((d: { id: string; retentionExpired: boolean }) => [d.id, d.retentionExpired])).toEqual([[open.body.id, true], [secret.body.id, true]]);
    expect((await manager.get(`/api/documents/${open.body.id}`).expect(200)).body).toMatchObject({ retentionExpired: true });
    const gone = await manager.get(`/api/documents/${open.body.id}/content`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('RETENTION_EXPIRED');
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get(`/api/documents/${secret.body.id}/content`)).status).toBe(404);
    expect((await viewer.get(`/api/documents/${open.body.id}/content`)).status).toBe(410);
  });

  it('reports lost bytes as an integrity failure and storage outages as unavailable', async () => {
    const { app, dir } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
    fs.rmSync(path.join(dir, blobKey(up.body.sha256)));
    const errors = captureLogs('error');
    try {
      const lost = await auditor.get(`/api/documents/${reg.body.id}/content`);
      expect(lost.status).toBe(500);
      expect(lost.body.code).toBe('STORAGE_INTEGRITY');
      expect(lost.headers['content-disposition']).toBeUndefined();
      expect(errors.text()).toContain(reg.body.id);
      expect(errors.text()).toContain(up.body.sha256);

      const outage = Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' });
      const down = await setup({ blobs: (local) => fakeStore(local, { get: async () => { throw outage; }, head: async () => { throw outage; }, put: async () => { throw outage; } }) });
      const a = await signIn(down.app, 'auditor');
      await down.svc.db.kysely.insertInto('blob_uploads').values({ sha256: sha256Of(SOP), uploaded_by: 'auditor' }).execute(); // as if uploaded before the outage
      for (const res of [await upload(a, SOP), await a.post('/api/documents', { sha256: sha256Of(SOP), filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' })]) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
      }
    } finally {
      errors.restore();
    }
  });

  it('survives a storage stream that fails mid-download', async () => {
    const { app } = await setup({
      blobs: (local) => fakeStore(local, {
        get: async () => new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('connection reset')); } }),
      }),
    });
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
    await expect(auditor.get(`/api/documents/${reg.body.id}/content`).buffer(true).parse(binary)).rejects.toThrow();
    await auditor.get(`/api/documents/${reg.body.id}`).expect(200);
  });

  it('redirects to a presigned link that forces a safe download and leaks nothing onward', async () => {
    const calls: unknown[][] = [];
    const { app } = await setup({
      presignDownloads: true,
      blobs: (local) => fakeStore(local, { presignedGet: async (...args) => { calls.push(args); return 'https://storage.example/obj?sig=1'; } }),
    });
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    for (const [mime, served] of [['text/html', 'application/octet-stream'], ['application/pdf', 'application/pdf']]) {
      const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'Bericht ü.html', mime, kind: 'other', classification: 'internal' }).expect(201);
      const res = await auditor.get(`/api/documents/${reg.body.id}/content`).redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://storage.example/obj?sig=1');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(calls.at(-1)).toEqual([up.body.sha256, 60, { contentType: served, filename: 'Bericht ü.html' }]);
    }
  });

  it('validates search and listing parameters', async () => {
    const { app, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    for (const qs of ['', 'q=', 'q=%20%20', `q=${'a'.repeat(501)}`, 'q=x&limit=0', 'q=x&limit=51', 'q=x&limit=abc', 'q=x&limit=1.5', 'q=x&q=y', 'q=x&kinds=sop&kinds=policy', 'q=x&engagementId=a&engagementId=b', 'q=x&kinds=invoice']) {
      const res = await auditor.get(`/api/knowledge/search?${qs}`);
      expect([qs, res.status]).toEqual([qs, 400]);
    }
    for (const qs of ['q=x', `q=${'a'.repeat(500)}`, 'q=x&limit=50', 'q=x&engagementId=', 'q=x&kinds=', 'q=x&kinds=sop,,policy,', 'q=the%20and%20of', `q=x&engagementId=${engagement.id}`]) {
      expect([qs, (await auditor.get(`/api/knowledge/search?${qs}`)).status]).toEqual([qs, 200]);
    }
    expect((await auditor.get('/api/documents?engagementId=a&engagementId=b')).status).toBe(400);
    expect((await auditor.get('/api/documents?engagementId=')).status).toBe(200);

    const up = await upload(auditor, SOP).expect(201);
    const base = { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' };
    for (const retainUntil of ['2026-13-45', '2026-02-30', '2026-2-3', 'tomorrow']) {
      expect([retainUntil, (await auditor.post('/api/documents', { ...base, retainUntil })).status]).toEqual([retainUntil, 400]);
    }
    expect((await auditor.post('/api/documents', { ...base, retainUntil: '2028-02-29' }).expect(201)).body.retainUntil).toBe('2028-02-29');
  });

  it('keeps admins away from documents', async () => {
    const { app } = await setup();
    const adminUser = await signIn(app, 'admin');
    expect((await adminUser.get('/api/documents')).status).toBe(403);
    expect((await adminUser.get('/api/knowledge/search?q=x')).status).toBe(403);
  });
});

it('still answers health checks without storage configured', async () => {
  const { app } = await setup({ blobs: false });
  await request(app).get('/api/health').expect(200);
});
