import crypto from 'node:crypto';
import type { Selectable } from 'kysely';
import type { DocumentsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import type { Classification, DocumentKind } from './access';
import { chunkText } from './chunk';

export type { Classification, DocumentKind } from './access';

export interface DocumentRecord {
  id: string;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: DocumentKind;
  classification: Classification;
  engagementId: string | null;
  uploadedBy: string;
  uploadedAt: string;
  retainUntil: string | null;
  retentionExpired: boolean;
  metadata: Record<string, unknown>;
}

export interface NewDocument {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: DocumentKind;
  classification: Classification;
  engagementId: string | null;
  uploadedBy: string;
  retainUntil?: string | null;
  metadata?: Record<string, unknown>;
}

function toRecord(r: Selectable<DocumentsTable>): DocumentRecord {
  return {
    id: r.id, sha256: r.sha256, filename: r.filename, mime: r.mime, size: Number(r.size), kind: r.kind, classification: r.classification,
    engagementId: r.engagement_id, uploadedBy: r.uploaded_by, uploadedAt: new Date(r.uploaded_at).toISOString(),
    retainUntil: r.retain_until ? new Date(r.retain_until).toISOString().slice(0, 10) : null, retentionExpired: r.retention_expired, metadata: r.metadata,
  };
}

export async function insertDocument(db: Executor, d: NewDocument): Promise<DocumentRecord> {
  const row = await db
    .insertInto('documents')
    .values({
      id: `DOC-${crypto.randomBytes(6).toString('hex')}`, sha256: d.sha256, filename: d.filename, mime: d.mime, size: d.size, kind: d.kind,
      classification: d.classification, engagement_id: d.engagementId, uploaded_by: d.uploadedBy, retain_until: d.retainUntil ?? null,
      metadata: JSON.stringify(d.metadata ?? {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export async function getDocument(db: Executor, id: string): Promise<DocumentRecord | null> {
  const row = await db.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toRecord(row) : null;
}

/** Documents in one scope (global when engagementId is null) that the reader's classifications allow. */
export async function listDocuments(db: Executor, f: { engagementId: string | null; classifications: readonly Classification[] }): Promise<DocumentRecord[]> {
  if (!f.classifications.length) return [];
  let q = db.selectFrom('documents').selectAll().where('classification', 'in', [...f.classifications]);
  q = f.engagementId === null ? q.where('engagement_id', 'is', null) : q.where('engagement_id', '=', f.engagementId);
  return (await q.orderBy('uploaded_at').orderBy('id').execute()).map(toRecord);
}

/** Stores a document's text once and indexes it as chunks carrying the document's classification and engagement. */
export async function setDocumentText(
  db: Executor,
  doc: DocumentRecord,
  t: { extractor: string; extractorVersion: string; text: string; pageStarts?: number[] },
): Promise<number> {
  const existing = await db.selectFrom('document_text').select('document_id').where('document_id', '=', doc.id).executeTakeFirst();
  if (existing) throw new AppError(409, `Document ${doc.id} already has text`);
  await db
    .insertInto('document_text')
    .values({ document_id: doc.id, extractor: t.extractor, extractor_version: t.extractorVersion, text: t.text, pages: JSON.stringify(t.pageStarts ?? []) })
    .execute();
  const chunks = chunkText(t.text, t.pageStarts);
  if (chunks.length) {
    await db
      .insertInto('chunks')
      .values(chunks.map((c) => ({
        id: `${doc.id}:${c.ordinal}`, document_id: doc.id, kg_node_id: null, ordinal: c.ordinal, page: c.page, text: c.text,
        classification: doc.classification, engagement_id: doc.engagementId,
      })))
      .execute();
  }
  return chunks.length;
}
