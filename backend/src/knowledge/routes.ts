import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { PREPARER_ROLES, READ_ROLES } from '../auth/roles';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuditService } from '../service';
import { assertSha256, BlobNotFound, type BlobStore } from '../storage/blob-store';
import { CLASSIFICATIONS, CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, mayRead } from './access';
import { getDocument, insertDocument, listDocuments, setDocumentText, type DocumentRecord } from './document-repo';
import { PgFtsRetriever } from './retriever';
import { recordDocumentEvent } from './trail';

export interface StorageDeps {
  blobs: BlobStore | null;
  maxUploadBytes: number;
  presignDownloads: boolean;
}

const MAX_TEXT_CHARS = 900_000;

const Register = z.object({
  sha256: z.string(),
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  kind: z.enum(DOCUMENT_KINDS),
  classification: z.enum(CLASSIFICATIONS),
  engagementId: z.string().min(1).nullable().optional(),
  retainUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  text: z.object({ content: z.string().max(MAX_TEXT_CHARS), pageStarts: z.array(z.number().int().min(0)).optional() }).optional(),
});

/** A safe Content-Disposition filename: no quotes, line breaks or path separators. */
const safeFilename = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'document';

/** Document upload, registry, download and search. All under /api, so session, CSRF and role gates apply. */
export function documentRoutes(svc: AuditService, storage: StorageDeps): Router {
  const r = Router();
  const db = svc.db.kysely;
  const readers = requireRole(READ_ROLES);
  const preparers = requireRole(PREPARER_ROLES);
  const blobs = () => {
    if (!storage.blobs) throw new AppError(503, 'File storage is not configured', 'STORAGE_UNAVAILABLE');
    return storage.blobs;
  };

  /** The document if this reader may see it; otherwise "not found", whether or not it exists. */
  const readable = async (id: string, role: Parameters<typeof mayRead>[0]): Promise<DocumentRecord> => {
    const doc = await getDocument(db, id);
    if (!doc || !mayRead(role, doc.classification)) throw new AppError(404, 'Document not found');
    return doc;
  };

  r.put('/api/blobs', preparers, express.raw({ type: () => true, limit: storage.maxUploadBytes }), wrap(async (req, res) => {
    const store = blobs();
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError(400, 'Send the file as the request body');
    const stored = await store.put(body, { mime: req.header('content-type') ?? 'application/octet-stream' });
    await db.insertInto('blob_uploads').values({ sha256: stored.sha256, uploaded_by: actorOf(req).id }).onConflict((oc) => oc.doNothing()).execute();
    res.status(201).json(stored);
  }));

  r.post('/api/documents', preparers, wrap(async (req, res) => {
    const store = blobs();
    const body = Register.parse(req.body);
    const sha256 = assertSha256(body.sha256);
    const actor = actorOf(req);
    if (!mayRead(actor.role, body.classification)) throw new AppError(403, `You may not file ${body.classification} documents`, 'FORBIDDEN');
    const engagementId = body.engagementId ?? null;
    if (engagementId) await svc.engagement(engagementId); // 404 if it doesn't exist
    // Only the uploader may register these bytes; the answer is the same whether or not someone else stored them.
    const uploaded = await db.selectFrom('blob_uploads').select('sha256').where('sha256', '=', sha256).where('uploaded_by', '=', actor.id).executeTakeFirst();
    const stored = uploaded ? await store.head(sha256) : null;
    if (!stored) throw new AppError(400, 'Upload the file first: no stored object has that SHA-256');

    const result = await db.transaction().execute(async (trx) => {
      const doc = await insertDocument(trx, {
        sha256, filename: body.filename, mime: body.mime, size: stored.size, kind: body.kind, classification: body.classification,
        engagementId, uploadedBy: actor.id, retainUntil: body.retainUntil ?? null, metadata: body.metadata,
      });
      const chunks = body.text ? await setDocumentText(trx, doc, { extractor: 'client', extractorVersion: '1', text: body.text.content, pageStarts: body.text.pageStarts }) : 0;
      await recordDocumentEvent(trx, actor, doc, chunks);
      return { ...doc, chunks };
    });
    res.status(201).json(result);
  }));

  r.get('/api/documents', readers, wrap(async (req, res) => {
    const actor = actorOf(req);
    const engagementId = typeof req.query.engagementId === 'string' && req.query.engagementId ? req.query.engagementId : null;
    res.json(await listDocuments(db, { engagementId, classifications: CLASSIFICATIONS_BY_ROLE[actor.role] }));
  }));

  r.get('/api/documents/:id', readers, wrap(async (req, res) => {
    res.json(await readable(String(req.params.id), actorOf(req).role));
  }));

  r.get('/api/documents/:id/content', readers, wrap(async (req, res: Response) => {
    const doc = await readable(String(req.params.id), actorOf(req).role);
    const store = blobs();
    if (storage.presignDownloads) {
      const url = await store.presignedGet(doc.sha256, 60);
      if (url) return res.redirect(url);
    }
    let stream;
    try {
      stream = await store.get(doc.sha256);
    } catch (err) {
      if (err instanceof BlobNotFound) throw new AppError(404, 'Document not found');
      throw err;
    }
    res.set({
      'Content-Type': doc.mime,
      'Content-Disposition': `attachment; filename="${safeFilename(doc.filename)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    stream.on('error', (err) => res.destroy(err));
    stream.pipe(res);
  }));

  r.get('/api/knowledge/search', readers, wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const engagementId = typeof req.query.engagementId === 'string' && req.query.engagementId ? req.query.engagementId : undefined;
    const kinds = typeof req.query.kinds === 'string' ? z.array(z.enum(DOCUMENT_KINDS)).parse(req.query.kinds.split(',')) : undefined;
    res.json(await new PgFtsRetriever(db).search(q, { user: actorOf(req), engagementId, kinds }));
  }));

  return r;
}
