import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { runRetention } from '../src/evidence/retention';
import { verifyIntegrity } from '../src/ops/verify';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { auditor, engagementWithFailedControl, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'evidence', n));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ROW = 'FD-HACCP-03';
const INPUT = { designAdequate: true, observation: 'All 20 CCP logs were signed and reviewed.', sampleTested: 20, exceptions: 0 };
// documents are uploaded through the real route, which refuses a past retainUntil: dates are in the future and the job's "today" is later still
const DUE = '2030-01-01';
const LATER = '2040-01-01';
const TODAY = '2031-01-01';

async function setup() {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const engagement = await engagementWithFailedControl(svc);
  const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ret-')));
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: 1024 * 1024, presignDownloads: false });
  const user = await signIn(app, 'auditor');
  const upload = async (file: string, filename: string, mime: string, retainUntil?: string) => {
    let r = user.agent.post(`/api/engagements/${engagement.id}/evidence`).set('x-csrf-token', user.csrf).field('kind', 'evidence').field('classification', 'internal');
    if (retainUntil) r = r.field('retainUntil', retainUntil);
    const res = await r.attach('file', fx(file), { filename, contentType: mime });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  return { svc, db: svc.db.kysely, engagement, blobs, user, upload };
}

describe('evidence retention job', () => {
  it('expires documents past their date and leaves linked ones, listing them [REQ-40]', async () => {
    const { svc, db, engagement, upload } = await setup();
    const past = await upload('sample.pdf', 'past.pdf', 'application/pdf', DUE);
    const linked = await upload('sample.docx', 'linked.docx', DOCX_MIME, DUE);
    const future = await upload('sample.xlsx', 'future.xlsx', 'application/octet-stream', LATER);
    const open = await upload('scanned.pdf', 'open.pdf', 'application/pdf');
    await svc.recordTest(engagement.id, ROW, { ...INPUT, evidenceRefs: [], evidence: [{ documentId: linked }] }, auditor);

    expect(await runRetention(db, TODAY)).toEqual({ expired: [past], retainedByRecord: [linked] });
    const state = Object.fromEntries((await db.selectFrom('documents').select(['id', 'retention_expired']).execute()).map((r) => [r.id, r.retention_expired]));
    expect(state).toEqual({ [past]: true, [linked]: false, [future]: false, [open]: false });
    // nothing is deleted
    expect(await db.selectFrom('documents').select('id').execute()).toHaveLength(4);
    // the date itself is not past: a document retained until today is kept
    expect(await runRetention(db, DUE)).toEqual({ expired: [], retainedByRecord: [] });
  });

  it('an expired document answers 410 on content and text, is absent from search, is still listed, and verify passes [REQ-40, REQ-24]', async () => {
    const { db, engagement, blobs, user, upload } = await setup();
    const id = await upload('sample.pdf', 'sample.pdf', 'application/pdf', DUE);
    expect((await user.get(`/api/knowledge/search?q=DEV-0031&engagementId=${engagement.id}`)).body).toHaveLength(1);
    expect((await user.get(`/api/documents/${id}/text`)).status).toBe(200);

    expect((await runRetention(db, TODAY)).expired).toEqual([id]);
    expect((await user.get(`/api/documents/${id}/content`)).status).toBe(410);
    const text = await user.get(`/api/documents/${id}/text`);
    expect(text.status).toBe(410);
    expect(text.body.code).toBe('RETENTION_EXPIRED');
    expect((await user.get(`/api/knowledge/search?q=DEV-0031&engagementId=${engagement.id}`)).body).toEqual([]);
    const list = await user.get(`/api/documents?engagementId=${engagement.id}`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id, retentionExpired: true })]);
    const report = await verifyIntegrity(db, blobs);
    expect(report.ok).toBe(true);
  });

  it('is idempotent', async () => {
    const { svc, db, engagement, upload } = await setup();
    const past = await upload('sample.pdf', 'past.pdf', 'application/pdf', DUE);
    const linked = await upload('sample.docx', 'linked.docx', DOCX_MIME, DUE);
    await svc.recordTest(engagement.id, ROW, { ...INPUT, evidenceRefs: [], evidence: [{ documentId: linked }] }, auditor);
    const first = await runRetention(db, TODAY);
    expect(first.expired).toEqual([past]);
    expect(await runRetention(db, TODAY)).toEqual({ expired: [], retainedByRecord: [linked] });
    expect(await runRetention(db, TODAY)).toEqual({ expired: [], retainedByRecord: [linked] });
  });
});
