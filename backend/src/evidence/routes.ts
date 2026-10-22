import type { Request } from 'express';
import { Router } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { PREPARER_ROLES, READ_ROLES } from '../auth/roles';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { CLASSIFICATIONS, CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, mayRead } from '../knowledge/access';
import { getDocument, insertDocument } from '../knowledge/document-repo';
import { CalendarDate, evidenceConfigOf, readableDocument, storageCall, storeOf, type StorageDeps } from '../knowledge/routes';
import { recordDocumentEvent } from '../knowledge/trail';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { sha256Of } from '../storage/blob-store';
import { runExtraction } from './extraction';
import { documentUsage } from './links';
import { latestExtraction } from './extraction-repo';
import { ContentMismatch, sniff } from './sniff';
import { documentPageText } from './text';

export const EVIDENCE_UPLOAD_PATH = '/api/engagements/:id/evidence';
export const DOCUMENT_UPLOAD_PATH = '/api/documents/upload';

const MAX_FIELDS = 8;
/** The note cap is 500 characters, which can be up to 4 bytes each in UTF-8. */
const MAX_FIELD_BYTES = 2048;
/** Multipart framing and the small text fields on top of the file itself. */
const BODY_OVERHEAD = 64 * 1024;

const NO_CONTROL = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
/** A note may span lines and use tabs; NUL and the other control characters are still refused. */
const NOTE_CONTROL = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Today (UTC) plus whole years, as a calendar date; 29 February in a non-leap year becomes 28 February. */
function plusYears(years: number): string {
  const now = new Date();
  const y = now.getUTCFullYear() + years;
  const d = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate()));
  return (d.getUTCMonth() !== now.getUTCMonth() ? new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)) : d).toISOString().slice(0, 10);
}

const Fields = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  classification: z.enum(CLASSIFICATIONS),
  retainUntil: CalendarDate.optional(),
  note: z.string().max(500).refine(NOTE_CONTROL, 'contains control characters').optional(),
});

interface Upload { bytes: Buffer; filename: string; mime: string; fields: Record<string, string> }

/**
 * Reads a multipart body with exactly one part named "file" into memory, plus its small text fields.
 * Over the size cap it stops consuming and refuses with 413; nothing has been stored by then.
 */
function readUpload(req: Request, maxBytes: number): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes + BODY_OVERHEAD) {
      req.resume();
      return reject(new AppError(413, 'The file is larger than the upload limit', 'UPLOAD_TOO_LARGE'));
    }
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES, parts: MAX_FIELDS + 2 }, defParamCharset: 'utf8' });
    } catch {
      return reject(new AppError(400, 'Send the file as multipart/form-data'));
    }
    const fields: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let file: { filename: string; mime: string } | null = null;
    let done = false;
    const fail = (err: AppError) => {
      if (done) return;
      done = true;
      req.unpipe(parser);
      req.resume(); // drain and discard the rest of the body
      reject(err);
    };

    parser.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) return fail(new AppError(400, `Field ${name} is too long`));
      fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || file) {
        stream.resume();
        return fail(new AppError(400, 'Send exactly one file, in a part named "file"'));
      }
      // busboy reports text/plain when the part has no Content-Type; that is undeclared, not a claim of text.
      file = { filename: info.filename ?? '', mime: info.mimeType === 'text/plain' ? 'application/octet-stream' : info.mimeType };
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => fail(new AppError(413, 'The file is larger than the upload limit', 'UPLOAD_TOO_LARGE')));
    });
    parser.on('filesLimit', () => fail(new AppError(400, 'Send exactly one file')));
    parser.on('fieldsLimit', () => fail(new AppError(400, 'Too many fields')));
    parser.on('partsLimit', () => fail(new AppError(400, 'Too many parts')));
    parser.on('error', () => fail(new AppError(400, 'The upload could not be read')));
    parser.on('close', () => {
      if (done) return;
      done = true;
      if (!file) return reject(new AppError(400, 'Send the file in a part named "file"'));
      resolve({ bytes: Buffer.concat(chunks), filename: file.filename, mime: file.mime, fields });
    });
    req.on('error', () => fail(new AppError(400, 'The upload was interrupted')));
    // The client went away mid-body: no response can be written, but the handler must not wait forever.
    req.on('close', () => { if (!req.complete) fail(new AppError(400, 'The upload was interrupted')); });
    req.pipe(parser);
  });
}

const Filename = z.string().transform((s) => s.replace(/^.*[\\/]/, '').trim()).pipe(z.string().min(1).max(255).refine(NO_CONTROL, 'contains control characters'));
const PageQuery = z.object({ page: z.string().regex(/^\d{1,9}$/).transform(Number).optional() });

/** Evidence intake (multipart upload), extraction retry and page text. All under /api, so session, CSRF and role gates apply. */
export function evidenceRoutes(svc: AuditService, storage: StorageDeps): Router {
  const r = Router();
  const db = svc.db.kysely;
  const preparers = requireRole(PREPARER_ROLES);
  const readers = requireRole(READ_ROLES);
  const config = evidenceConfigOf(storage);
  const blobs = () => storeOf(storage);

  async function intake(req: Request, scope: { engagementId: string | null }) {
    const store = blobs();
    const actor = actorOf(req);
    const up = await readUpload(req, storage.maxUploadBytes);
    const fields = Fields.parse(up.fields);
    const filename = Filename.parse(up.filename);
    if (!up.bytes.length) throw new AppError(400, 'The file is empty');
    if (scope.engagementId === null && fields.kind === 'evidence') throw new AppError(400, 'Evidence belongs to an engagement; upload it there');
    if (fields.retainUntil !== undefined && fields.retainUntil < todayUtc()) throw new AppError(400, 'retainUntil is in the past');
    if (!mayRead(actor.role, fields.classification)) throw new AppError(403, `You may not file ${fields.classification} documents`, 'FORBIDDEN');
    if (scope.engagementId) await svc.engagement(scope.engagementId); // 404 if it doesn't exist

    let sniffed: ReturnType<typeof sniff>;
    try {
      sniffed = sniff(up.bytes, up.mime, filename);
    } catch (err) {
      if (err instanceof ContentMismatch) throw new AppError(400, err.message, 'CONTENT_MISMATCH');
      throw err;
    }

    const sha256 = sha256Of(up.bytes);
    // Only documents this caller may read count: the answer must not reveal a restricted copy to someone who cannot see it.
    let q = db.selectFrom('documents').select(['id', 'kind', 'classification']).where('sha256', '=', sha256).where('retention_expired', '=', false).where('classification', 'in', [...CLASSIFICATIONS_BY_ROLE[actor.role]]);
    q = scope.engagementId === null ? q.where('engagement_id', 'is', null) : q.where('engagement_id', '=', scope.engagementId);
    const same = await q.orderBy('uploaded_at').orderBy('id').execute();
    if (same.length) {
      const exact = same.find((d) => d.kind === fields.kind && d.classification === fields.classification);
      if (!exact) throw new AppError(409, `These bytes are already filed here as ${same[0].id} with a different kind or classification`, 'DUPLICATE_DIFFERS', { existingId: same[0].id });
      return { status: 200, body: { ...(await getDocument(db, exact.id))!, duplicate: true } };
    }

    const stored = await storageCall('put', () => store.put(up.bytes, { mime: 'application/octet-stream' }));
    const retainUntil = fields.retainUntil ?? (config.retentionYears ? plusYears(config.retentionYears) : null);
    const doc = await db.transaction().execute(async (trx) => {
      const d = await insertDocument(trx, {
        sha256: stored.sha256, filename, mime: sniffed.mime, size: stored.size, kind: fields.kind, classification: fields.classification,
        engagementId: scope.engagementId, uploadedBy: actor.id, retainUntil, metadata: fields.note ? { note: fields.note } : {},
      });
      await trx.insertInto('blob_uploads').values({ sha256: stored.sha256, uploaded_by: actor.id }).onConflict((oc) => oc.doNothing()).execute();
      await recordDocumentEvent(trx, actor, d, 0);
      return d;
    });
    // The registration is committed; a failing extractor must not turn it into an error (the retry route covers extraction: null).
    try {
      await runExtraction({ db, blobs: store, config }, doc, actor, { bytes: up.bytes });
    } catch (err) {
      logger.error({ err, documentId: doc.id }, 'Extraction failed after upload');
    }
    const chunks = Number((await db.selectFrom('chunks').select((eb) => eb.fn.countAll().as('n')).where('document_id', '=', doc.id).executeTakeFirstOrThrow()).n);
    return { status: 201, body: { ...(await getDocument(db, doc.id))!, chunks } };
  }

  r.post(EVIDENCE_UPLOAD_PATH, preparers, wrap(async (req, res) => {
    const out = await intake(req, { engagementId: String(req.params.id) });
    res.status(out.status).json(out.body);
  }));

  r.post(DOCUMENT_UPLOAD_PATH, preparers, wrap(async (req, res) => {
    const out = await intake(req, { engagementId: null });
    res.status(out.status).json(out.body);
  }));

  r.post('/api/documents/:id/extract', preparers, wrap(async (req, res) => {
    const store = blobs();
    const actor = actorOf(req);
    const doc = await readableDocument(db, String(req.params.id), actor.role);
    if (doc.retentionExpired) throw new AppError(410, 'This document is past its retention date', 'RETENTION_EXPIRED');
    const latest = await latestExtraction(db, doc.id);
    const hasText = await db.selectFrom('document_text').select('document_id').where('document_id', '=', doc.id).executeTakeFirst();
    if (hasText || latest?.status === 'ok' || latest?.status === 'client') throw new AppError(409, 'This document already has extracted text', 'EXTRACTION_EXISTS');
    if (latest?.status === 'unsupported' || latest?.status === 'no_text') throw new AppError(409, 'Another attempt cannot produce text for this file', 'UNSUPPORTED');
    // failed, too_large, or no attempt recorded at all: run a new one against the stored bytes.
    await runExtraction({ db, blobs: store, config }, doc, actor);
    res.json((await getDocument(db, doc.id))!);
  }));

  r.get('/api/documents/:id/text', readers, wrap(async (req, res) => {
    const { page } = PageQuery.parse(req.query);
    const doc = await readableDocument(db, String(req.params.id), actorOf(req).role);
    // Only after the read check, so a 410 never reveals a document the reader may not see.
    if (doc.retentionExpired) throw new AppError(410, 'This document is past its retention date', 'RETENTION_EXPIRED');
    const result = await documentPageText(db, doc.id, page);
    if (!result) throw new AppError(404, 'This document has no extracted text', 'NOT_FOUND');
    res.json(result);
  }));

  // Where a document is cited: the tests and live findings that link it. Unreadable and missing documents answer alike.
  r.get('/api/documents/:id/usage', requireRole(READ_ROLES), wrap(async (req, res) => {
    const doc = await readableDocument(svc.db.kysely, String(req.params.id), actorOf(req).role);
    // Every read role may list every engagement (GET /api/engagements is not scoped), so the scan covers them all.
    res.json(await documentUsage(svc.db.kysely, doc.id));
  }));

  return r;
}
