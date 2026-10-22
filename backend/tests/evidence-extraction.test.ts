import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { loadEvidenceConfig, type EvidenceConfig } from '../src/evidence/config';
import { runExtraction } from '../src/evidence/extraction';
import { latestExtraction } from '../src/evidence/extraction-repo';
import { EXTRACTORS } from '../src/evidence/extract';
import { getDocument, insertDocument } from '../src/knowledge/document-repo';
import { PgFtsRetriever } from '../src/knowledge/retriever';
import { sha256Of } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { createApp } from '../src/app';
import { auditor, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'evidence', n));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function setup(over: Partial<EvidenceConfig> = {}) {
  const svc = await newService();
  const db = svc.db.kysely;
  await ensureDevUsers(db);
  const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-')));
  const config: EvidenceConfig = { ...loadEvidenceConfig({}, { maxBytes: 25 * 1024 * 1024 }), ...over };
  const register = async (bytes: Buffer, filename: string, mime: string) => {
    await blobs.put(bytes, { mime });
    return insertDocument(db, { sha256: sha256Of(bytes), filename, mime, size: bytes.length, kind: 'evidence', classification: 'internal', engagementId: null, uploadedBy: auditor.id });
  };
  const chunkCount = async (id: string) => Number((await db.selectFrom('chunks').select((eb) => eb.fn.countAll().as('n')).where('document_id', '=', id).executeTakeFirstOrThrow()).n);
  return { svc, db, blobs, config, deps: { db, blobs, config }, register, chunkCount };
}

describe('evidence extraction', () => {
  it('records a client-text registration as status client [REQ-38]', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const blobs = new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-')));
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: 1024 * 1024, presignDownloads: false });
    const user = await signIn(app, 'auditor');
    const bytes = Buffer.from('%PDF-1.4 client side');
    const up = await user.agent.put('/api/blobs').set('x-csrf-token', user.csrf).set('Content-Type', 'application/pdf').send(bytes).expect(201);
    const reg = await user.post('/api/documents', { sha256: up.body.sha256, filename: 'a.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal', text: { content: 'Hello client text.', pageStarts: [0] } }).expect(201);
    expect(reg.body.extraction).toMatchObject({ status: 'client', extractor: 'client', version: '1', chars: 18, pages: 1, error: null });
    const row = await latestExtraction(svc.db.kysely, reg.body.id);
    expect(row).toMatchObject({ attempt: 1, status: 'client', by: 'auditor' });
  });

  it('extracts a registered pdf from the stored bytes and chunks it [REQ-38]', async () => {
    const { db, deps, register, chunkCount } = await setup();
    const doc = await register(fx('sample.pdf'), 'sample.pdf', 'application/pdf');
    const row = await runExtraction(deps, doc, auditor);
    expect(row).toMatchObject({ status: 'ok', attempt: 1, pages: 2, extractor: EXTRACTORS.pdf!.name, extractorVersion: EXTRACTORS.pdf!.version, by: 'auditor', error: null });
    expect(await chunkCount(doc.id)).toBeGreaterThanOrEqual(2);
    const hits = await new PgFtsRetriever(db).search('DEV-0031', { user: auditor });
    expect(hits[0].citation).toMatchObject({ documentId: doc.id, page: 2 });
    const trail = (await readTrail(db)).at(-1)!;
    expect(trail).toMatchObject({ moduleId: 'document:extract', actor: 'auditor', inputs: { documentId: doc.id, sha256: doc.sha256, extractor: row.extractor, version: row.extractorVersion }, output: { status: 'ok', chars: row.chars, pages: 2 } });
    expect(JSON.stringify(trail)).not.toContain('DEV-0031');
    expect((await getDocument(db, doc.id))!.extraction).toMatchObject({ status: 'ok', pages: 2 });
  });

  it('refuses to extract bytes whose hash is not the documents [REQ-38]', async () => {
    const { db, deps, register, chunkCount } = await setup();
    const doc = await register(fx('sample.pdf'), 'sample.pdf', 'application/pdf');
    const before = (await readTrail(db)).length;
    await expect(runExtraction(deps, doc, auditor, { bytes: fx('sample.docx') })).rejects.toThrow(/hash/i);
    expect(await latestExtraction(db, doc.id)).toBeNull();
    expect(await chunkCount(doc.id)).toBe(0);
    expect((await readTrail(db)).length).toBe(before);
    expect((await runExtraction(deps, doc, auditor, { bytes: fx('sample.pdf') })).status).toBe('ok');
  });

  it('marks a scanned pdf no_text and a zip unsupported, and keeps both searchable-less', async () => {
    const { deps, register, chunkCount, db } = await setup();
    const scanned = await register(fx('scanned.pdf'), 'scan.pdf', 'application/pdf');
    expect(await runExtraction(deps, scanned, auditor)).toMatchObject({ status: 'no_text', chars: 0 });
    const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]);
    const zip = await register(zipBytes, 'a.zip', 'application/zip');
    expect(await runExtraction(deps, zip, auditor)).toMatchObject({ status: 'unsupported' });
    for (const d of [scanned, zip]) {
      expect(await chunkCount(d.id)).toBe(0);
      expect(await db.selectFrom('document_text').select('document_id').where('document_id', '=', d.id).execute()).toEqual([]);
    }
  });

  it('marks too_large above EXTRACT_MAX_BYTES and above the zip inflation cap', async () => {
    const small = await setup({ extractMaxBytes: 100 });
    const pdfDoc = await small.register(fx('sample.pdf'), 'sample.pdf', 'application/pdf');
    expect(await runExtraction(small.deps, pdfDoc, auditor)).toMatchObject({ status: 'too_large' });
    const zipCap = await setup({ zipMaxUncompressedBytes: 10 });
    const docxDoc = await zipCap.register(fx('sample.docx'), 'a.docx', DOCX_MIME);
    expect(await runExtraction(zipCap.deps, docxDoc, auditor)).toMatchObject({ status: 'too_large' });
    expect(await zipCap.chunkCount(docxDoc.id)).toBe(0);
  });

  it('marks failed on timeout with the error text and allows a second attempt', async () => {
    const { deps, db, register, chunkCount } = await setup({ extractTimeoutMs: 1 });
    const doc = await register(fx('sample.pdf'), 'sample.pdf', 'application/pdf');
    const real = EXTRACTORS.pdf!;
    EXTRACTORS.pdf = { ...real, extract: () => new Promise((r) => setTimeout(() => r({ text: 'late', pageStarts: null, pages: null }), 200)) };
    try {
      const failed = await runExtraction(deps, doc, auditor);
      expect(failed).toMatchObject({ status: 'failed', attempt: 1, chars: 0 });
      expect(failed.error).toMatch(/timed out/i);
      expect(await chunkCount(doc.id)).toBe(0);
    } finally {
      EXTRACTORS.pdf = real;
    }
    const again = await runExtraction({ ...deps, config: { ...deps.config, extractTimeoutMs: 30000 } }, doc, auditor);
    expect(again).toMatchObject({ status: 'ok', attempt: 2 });
    expect((await latestExtraction(db, doc.id))!.attempt).toBe(2);
  });

  it('cuts text over the limit at a paragraph boundary and marks it truncated', async () => {
    const { deps, register, db } = await setup();
    const para = 'x'.repeat(9_990);
    const big = Buffer.from(Array.from({ length: 100 }, () => para).join('\n\n'));
    const doc = await register(big, 'big.txt', 'text/plain');
    const row = await runExtraction(deps, doc, auditor);
    expect(row.status).toBe('ok');
    expect(row.chars).toBe(big.length);
    const t = await db.selectFrom('document_text').select('text').where('document_id', '=', doc.id).executeTakeFirstOrThrow();
    expect(t.text.endsWith('\n\n[truncated]')).toBe(true);
    expect(t.text.length).toBeLessThan(900_100);
  });

  it('marks failed when the bytes no longer match the declared type', async () => {
    const { deps, register } = await setup();
    const doc = await register(fx('sample.docx'), 'a.pdf', 'application/pdf');
    const row = await runExtraction(deps, doc, auditor);
    expect(row.status).toBe('failed');
    expect(row.error!.length).toBeLessThanOrEqual(200);
  });

  it('loads config defaults and refuses bad values', () => {
    expect(loadEvidenceConfig({}, { maxBytes: 5 })).toEqual({ extractMaxBytes: 5, extractTimeoutMs: 30000, zipMaxUncompressedBytes: 268435456, retentionYears: null });
    expect(loadEvidenceConfig({ EXTRACT_MAX_BYTES: '9', EXTRACT_TIMEOUT_MS: '5', ZIP_MAX_UNCOMPRESSED_BYTES: '7', EVIDENCE_RETENTION_YEARS: '10' })).toEqual({ extractMaxBytes: 9, extractTimeoutMs: 5, zipMaxUncompressedBytes: 7, retentionYears: 10 });
    expect(() => loadEvidenceConfig({ EXTRACT_MAX_BYTES: '0', EXTRACT_TIMEOUT_MS: 'abc', EVIDENCE_RETENTION_YEARS: '-1' })).toThrow(/EXTRACT_MAX_BYTES[\s\S]*EXTRACT_TIMEOUT_MS[\s\S]*EVIDENCE_RETENTION_YEARS/);
  });
});
