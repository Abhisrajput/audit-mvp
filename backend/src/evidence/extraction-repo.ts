import { sql } from 'kysely';
import type { Executor } from '../db/trail-repo';

export type ExtractionStatus = 'ok' | 'no_text' | 'failed' | 'too_large' | 'unsupported' | 'client';

export interface ExtractionRow {
  documentId: string;
  attempt: number;
  extractor: string;
  extractorVersion: string;
  status: ExtractionStatus;
  chars: number;
  pages: number | null;
  error: string | null;
  at: string;
  by: string;
}

type Raw = { document_id: string; attempt: number; extractor: string; extractor_version: string; status: ExtractionStatus; chars: number; pages: number | null; error: string | null; extracted_at: Date; extracted_by: string };

const toRow = (r: Raw): ExtractionRow => ({
  documentId: r.document_id, attempt: r.attempt, extractor: r.extractor, extractorVersion: r.extractor_version, status: r.status,
  chars: r.chars, pages: r.pages, error: r.error, at: new Date(r.extracted_at).toISOString(), by: r.extracted_by,
});

/** Appends one attempt; its number is the document's previous highest plus one (the UNIQUE key refuses a concurrent duplicate). */
export async function insertExtraction(db: Executor, row: Omit<ExtractionRow, 'attempt' | 'at'>): Promise<ExtractionRow> {
  const res = await sql<Raw>`
    INSERT INTO document_extractions (document_id, attempt, extractor, extractor_version, status, chars, pages, error, extracted_by)
    SELECT ${row.documentId}, COALESCE(MAX(attempt), 0) + 1, ${row.extractor}, ${row.extractorVersion}, ${row.status}, ${row.chars}, ${row.pages}, ${row.error}, ${row.by}
    FROM document_extractions WHERE document_id = ${row.documentId}
    RETURNING document_id, attempt, extractor, extractor_version, status, chars, pages, error, extracted_at, extracted_by`.execute(db);
  return toRow(res.rows[0]);
}

export async function latestExtraction(db: Executor, documentId: string): Promise<ExtractionRow | null> {
  return (await latestExtractions(db, [documentId])).get(documentId) ?? null;
}

/** The newest attempt for each given document, in one query. */
export async function latestExtractions(db: Executor, documentIds: string[]): Promise<Map<string, ExtractionRow>> {
  const out = new Map<string, ExtractionRow>();
  if (!documentIds.length) return out;
  const res = await sql<Raw>`
    SELECT DISTINCT ON (document_id) document_id, attempt, extractor, extractor_version, status, chars, pages, error, extracted_at, extracted_by
    FROM document_extractions WHERE document_id IN (${sql.join(documentIds)})
    ORDER BY document_id, attempt DESC`.execute(db);
  for (const r of res.rows) out.set(r.document_id, toRow(r));
  return out;
}
