import { AppError } from '../errors';
import type { Executor } from '../db/trail-repo';

/**
 * A document's extracted text, whole or one page of it. `page` is 1-based over the stored 0-based start offsets.
 * Null when the document has no extracted text; a 400 when a page is asked of a document with no page breaks or is out of range.
 */
export async function documentPageText(db: Executor, documentId: string, page?: number): Promise<{ page: number | null; pages: number | null; text: string } | null> {
  const row = await db.selectFrom('document_text').select(['text', 'pages']).where('document_id', '=', documentId).executeTakeFirst();
  if (!row) return null;
  const starts = row.pages ?? [];
  const pages = starts.length || null;
  if (page === undefined) return { page: null, pages, text: row.text };
  if (!pages) throw new AppError(400, 'This document has no page breaks');
  if (page < 1 || page > pages) throw new AppError(400, `Page must be between 1 and ${pages}`);
  return { page, pages, text: row.text.slice(starts[page - 1], starts[page] ?? row.text.length) };
}
