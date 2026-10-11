import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { sha256Of } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { engagementWithFailedControl, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

async function setup(opts: { blobs?: boolean; maxUploadBytes?: number } = {}) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const engagement = await engagementWithFailedControl(svc);
  const blobs = opts.blobs === false ? null : new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-')));
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: opts.maxUploadBytes ?? 1024 * 1024, presignDownloads: false });
  return { svc, app, engagement };
}

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
  });

  it('serves the exact bytes back, as a download that cannot be sniffed', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'SOP "ALG"\r\n.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
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

  it("answers 404 for a document the reader may not see, exactly as for one that doesn't exist", async () => {
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
