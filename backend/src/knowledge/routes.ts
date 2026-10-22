import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { PREPARER_ROLES, READ_ROLES } from '../auth/roles';
import type { Executor } from '../db/trail-repo';
import type { Role } from '../engine/types';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { assertSha256, attachmentDisposition, BlobNotFound, type BlobStore } from '../storage/blob-store';
import { CLASSIFICATIONS, CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, mayRead } from './access';
import { loadEvidenceConfig, MAX_TEXT_CHARS, type EvidenceConfig } from '../evidence/config';
import { runExtraction } from '../evidence/extraction';
import { insertExtraction } from '../evidence/extraction-repo';
import { getDocument, insertDocument, listDocuments, setDocumentText, type DocumentRecord } from './document-repo';
import { MAX_HITS, PgFtsRetriever } from './retriever';
import { recordDocumentEvent } from './trail';

export interface StorageDeps {
  blobs: BlobStore | null;
  maxUploadBytes: number;
  presignDownloads: boolean;
  /** Extraction limits; defaults apply when absent. */
  evidence?: EvidenceConfig;
}

export const UPLOAD_PATH = '/api/blobs';

const MAX_QUERY_CHARS = 500;

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is not). */
export const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'Not a calendar date');

const Register = z.object({
  sha256: z.string(),
  filename: z.string().min(1).max(255),
  mime: z.string().max(200).regex(/^[\w.+-]+\/[\w.+-]+$/, 'A media type such as application/pdf'),
  kind: z.enum(DOCUMENT_KINDS),
  classification: z.enum(CLASSIFICATIONS),
  engagementId: z.string().min(1).nullable().optional(),
  retainUntil: CalendarDate.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  text: z.object({ content: z.string().max(MAX_TEXT_CHARS), pageStarts: z.array(z.number().int().min(0)).optional() }).optional(),
});

/** A single optional query-string value; repeating the parameter (an array) is a 400. '' counts as absent. */
const OneValue = z.string().optional().transform((v) => v || undefined);

const ListQuery = z.object({ engagementId: OneValue });

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  engagementId: OneValue,
  kinds: z
    .string()
    .optional()
    .transform((v) => v?.split(',').map((k) => k.trim()).filter(Boolean))
    .pipe(z.array(z.enum(DOCUMENT_KINDS)).optional())
    .transform((v) => (v?.length ? v : undefined)),
  limit: z.coerce.number().int().min(1).max(MAX_HITS).optional(),
});

/** Types a browser would render or run (HTML, SVG, XML, scripts) are served as opaque bytes. */
const ACTIVE_CONTENT = /html|xml|javascript/i;
const servedType = (mime: string) => (ACTIVE_CONTENT.test(mime) ? 'application/octet-stream' : mime);

/**
 * Runs a storage call. A missing object (BlobNotFound) and our own validation errors pass through;
 * anything else (missing bucket, denied credentials, network) is logged and answered 503.
 */
export async function storageCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError || err instanceof BlobNotFound) throw err;
    logger.error({ err, what }, 'File storage failed');
    throw new AppError(503, 'File storage is unavailable', 'STORAGE_UNAVAILABLE');
  }
}

/** The configured blob store, or 503 when file storage is not set up. */
export function storeOf(storage: StorageDeps): BlobStore {
  if (!storage.blobs) throw new AppError(503, 'File storage is not configured', 'STORAGE_UNAVAILABLE');
  return storage.blobs;
}

/** Extraction limits: the configured ones, or the defaults sized to the upload cap. */
export const evidenceConfigOf = (storage: StorageDeps): EvidenceConfig => storage.evidence ?? loadEvidenceConfig({}, { maxBytes: storage.maxUploadBytes });

/** The document if this reader may see it; otherwise "not found", whether or not it exists. */
export async function readableDocument(db: Executor, id: string, role: Role): Promise<DocumentRecord> {
  const doc = await getDocument(db, id);
  if (!doc || !mayRead(role, doc.classification)) throw new AppError(404, 'Document not found');
  return doc;
}

/** Document upload, registry, download and search. All under /api, so session, CSRF and role gates apply. */
export function documentRoutes(svc: AuditService, storage: StorageDeps): Router {
  const r = Router();
  const db = svc.db.kysely;
  const readers = requireRole(READ_ROLES);
  const preparers = requireRole(PREPARER_ROLES);
  const evidence = evidenceConfigOf(storage);
  const blobs = () => storeOf(storage);

  const readable = (id: string, role: Role) => readableDocument(db, id, role);

  r.put(UPLOAD_PATH, preparers, express.raw({ type: () => true, limit: storage.maxUploadBytes }), wrap(async (req, res) => {
    const store = blobs();
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError(400, 'Send the file as the request body');
    // The uploader's Content-Type is never stored; the registry's validated mime decides how it is served.
    const stored = await storageCall('put', () => store.put(body, { mime: 'application/octet-stream' }));
    await db.insertInto('blob_uploads').values({ sha256: stored.sha256, uploaded_by: actorOf(req).id }).onConflict((oc) => oc.doNothing()).execute();
    res.status(201).json(stored);
  }));

  r.post('/api/documents', preparers, express.json({ limit: '4mb' }), wrap(async (req, res) => {
    const store = blobs();
    const body = Register.parse(req.body);
    const sha256 = assertSha256(body.sha256);
    const actor = actorOf(req);
    if (!mayRead(actor.role, body.classification)) throw new AppError(403, `You may not file ${body.classification} documents`, 'FORBIDDEN');
    const engagementId = body.engagementId ?? null;
    if (engagementId) await svc.engagement(engagementId); // 404 if it doesn't exist
    // Only the uploader may register these bytes; the answer is the same whether or not someone else stored them.
    const uploaded = await db.selectFrom('blob_uploads').select('sha256').where('sha256', '=', sha256).where('uploaded_by', '=', actor.id).executeTakeFirst();
    const stored = uploaded ? await storageCall('head', () => store.head(sha256)) : null;
    if (!stored) throw new AppError(400, 'Upload the file first: no stored object has that SHA-256');

    const registered = await db.transaction().execute(async (trx) => {
      const doc = await insertDocument(trx, {
        sha256, filename: body.filename, mime: body.mime, size: stored.size, kind: body.kind, classification: body.classification,
        engagementId, uploadedBy: actor.id, retainUntil: body.retainUntil ?? null, metadata: body.metadata,
      });
      const chunks = body.text ? await setDocumentText(trx, doc, { extractor: 'client', extractorVersion: '1', text: body.text.content, pageStarts: body.text.pageStarts }) : 0;
      if (body.text) {
        await insertExtraction(trx, { documentId: doc.id, extractor: 'client', extractorVersion: '1', status: 'client', chars: body.text.content.length, pages: body.text.pageStarts?.length ?? null, error: null, by: actor.id });
      }
      await recordDocumentEvent(trx, actor, doc, chunks);
      return { doc, chunks };
    });
    // No text supplied: the server reads the stored bytes itself, in its own transaction, so a slow or failing
    // extractor never undoes the registration; its outcome is the document's extraction status.
    // If it throws, the document still exists: answer 201 with extraction: null, which the retry route treats as retryable.
    if (!body.text) {
      try {
        await runExtraction({ db, blobs: store, config: evidence }, registered.doc, actor);
      } catch (err) {
        logger.error({ err, documentId: registered.doc.id }, 'Extraction failed after registration');
      }
    }
    const doc = (await getDocument(db, registered.doc.id))!;
    const chunks = body.text ? registered.chunks : Number((await db.selectFrom('chunks').select((eb) => eb.fn.countAll().as('n')).where('document_id', '=', doc.id).executeTakeFirstOrThrow()).n);
    const result = { ...doc, chunks };
    res.status(201).json(result);
  }));

  // Expired documents stay listed (retentionExpired: true) so the registry remains auditable; only their content is refused.
  r.get('/api/documents', readers, wrap(async (req, res) => {
    const actor = actorOf(req);
    const { engagementId } = ListQuery.parse(req.query);
    res.json(await listDocuments(db, { engagementId: engagementId ?? null, classifications: CLASSIFICATIONS_BY_ROLE[actor.role] }));
  }));

  r.get('/api/documents/:id', readers, wrap(async (req, res) => {
    res.json(await readable(String(req.params.id), actorOf(req).role));
  }));

  r.get('/api/documents/:id/content', readers, wrap(async (req, res: Response) => {
    const doc = await readable(String(req.params.id), actorOf(req).role);
    // Only after the read check, so a 410 never reveals a document the reader may not see.
    if (doc.retentionExpired) throw new AppError(410, 'This document is past its retention date', 'RETENTION_EXPIRED');
    const store = blobs();
    const download = { contentType: servedType(doc.mime), filename: doc.filename };
    if (storage.presignDownloads) {
      const url = await storageCall('presign', () => store.presignedGet(doc.sha256, 60, download));
      if (url) {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.redirect(url);
      }
    }
    // Every header is set before the object is opened, so nothing can fail between opening it and streaming it.
    const headers = {
      'Content-Type': download.contentType,
      'Content-Disposition': attachmentDisposition(doc.filename),
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    };
    res.set(headers);
    let stream: Readable;
    try {
      stream = await storageCall('get', () => store.get(doc.sha256));
    } catch (err) {
      for (const name of Object.keys(headers)) res.removeHeader(name);
      if (!(err instanceof BlobNotFound)) throw err;
      // The registry says these bytes exist: losing them is an integrity failure, not "not found".
      logger.error({ documentId: doc.id, sha256: doc.sha256 }, 'Stored bytes missing for document');
      throw new AppError(500, 'The stored file is missing', 'STORAGE_INTEGRITY');
    }
    try {
      await pipeline(stream, res);
    } catch (err) {
      // The client went away: pipeline has already closed the storage stream.
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      // Headers (and maybe bytes) are out, so no JSON error is possible; the response was destroyed.
      logger.error({ err, documentId: doc.id }, 'Download failed');
    }
  }));

  r.get('/api/knowledge/search', readers, wrap(async (req, res) => {
    const { q, engagementId, kinds, limit } = SearchQuery.parse(req.query);
    res.json(await new PgFtsRetriever(db).search(q, { user: actorOf(req), engagementId, kinds, limit }));
  }));

  return r;
}
