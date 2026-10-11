import crypto from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { DocumentsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import type { Classification, DocumentKind } from './access';
import { chunkText, normalisePageStarts } from './chunk';

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
    retainUntil: r.retain_until, retentionExpired: r.retention_expired, metadata: r.metadata,
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

/** Global documents, plus one engagement's when engagementId is given, that the reader's classifications allow. */
export async function listDocuments(db: Executor, f: { engagementId: string | null; classifications: readonly Classification[] }): Promise<DocumentRecord[]> {
  if (!f.classifications.length) return [];
  let q = db.selectFrom('documents').selectAll().where('classification', 'in', [...f.classifications]);
  // An engagement's listing includes global documents, as search does; never another engagement's.
  const engagementId = f.engagementId;
  q = engagementId === null ? q.where('engagement_id', 'is', null) : q.where((eb) => eb.or([eb('engagement_id', 'is', null), eb('engagement_id', '=', engagementId)]));
  return (await q.orderBy('uploaded_at').orderBy('id').execute()).map(toRecord);
}

/**
 * Stores a document's text once and indexes it as chunks. The chunks' classification and
 * engagement are copied from the documents row in the same statement, never from the caller.
 * A second call for the same document (even a concurrent one) is a 409.
 */
export async function setDocumentText(
  db: Executor,
  doc: Pick<DocumentRecord, 'id'>,
  t: { extractor: string; extractorVersion: string; text: string; pageStarts?: number[] },
): Promise<number> {
  const pageStarts = normalisePageStarts(t.pageStarts);
  const inserted = await db
    .insertInto('document_text')
    .values({ document_id: doc.id, extractor: t.extractor, extractor_version: t.extractorVersion, text: t.text, pages: JSON.stringify(pageStarts) })
    .onConflict((oc) => oc.column('document_id').doNothing())
    .returning('document_id')
    .executeTakeFirst();
  if (!inserted) throw new AppError(409, `Document ${doc.id} already has text`);
  const chunks = chunkText(t.text, pageStarts);
  if (chunks.length) {
    const rows = sql.join(chunks.map((c) => sql`(${c.ordinal}::integer, ${c.page}::integer, ${c.text}::text)`));
    await sql`
      INSERT INTO chunks (id, document_id, kg_node_id, ordinal, page, text, classification, engagement_id)
      SELECT d.id || ':' || v.ordinal, d.id, NULL, v.ordinal, v.page, v.text, d.classification, d.engagement_id
      FROM documents d CROSS JOIN (VALUES ${rows}) AS v (ordinal, page, text)
      WHERE d.id = ${doc.id}`.execute(db);
  }
  return chunks.length;
}
