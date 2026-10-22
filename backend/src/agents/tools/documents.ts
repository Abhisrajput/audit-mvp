import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../../db/schema';
import type { User } from '../../engine/types';
import { AppError } from '../../errors';
import { documentPageText } from '../../evidence/text';
import { mayRead } from '../../knowledge/access';
import { getDocument } from '../../knowledge/document-repo';

// The evidence agent's document reader (spec §9.1). Evidence only: documents of kind `evidence` on this engagement, that
// the run's starter may read and whose retention has not expired. Every other case gets the same not-found answer.

export const MAX_PAGES = 6;
export const MAX_CHARS = 12_000;

export const ReadDocumentArgs = z.object({
  documentId: z.string().min(1).max(64),
  pages: z.array(z.number().int().positive()).max(MAX_PAGES).optional(),
}).strict();

export interface DocumentText {
  documentId: string;
  filename: string;
  pages: { page: number | null; text: string }[];
  /** Whether pages or characters were left out to stay within the caps. */
  truncated: boolean;
}

export async function readDocument(db: Kysely<DB>, user: User, engagementId: string, args: z.infer<typeof ReadDocumentArgs>): Promise<DocumentText> {
  const notFound = () => new AppError(404, `Document ${args.documentId} was not found`, 'NOT_FOUND');
  const doc = await getDocument(db, args.documentId);
  if (!doc || doc.kind !== 'evidence' || doc.engagementId !== engagementId || !mayRead(user.role, doc.classification) || doc.retentionExpired) throw notFound();

  const first = await documentPageText(db, doc.id);
  if (!first) throw notFound();
  let wanted: (number | undefined)[];
  let truncated = false;
  if (args.pages) wanted = [...new Set(args.pages)];
  else if (!first.pages) wanted = [undefined];
  else {
    wanted = Array.from({ length: Math.min(MAX_PAGES, first.pages) }, (_, i) => i + 1);
    truncated = first.pages > MAX_PAGES;
  }

  const pages: DocumentText['pages'] = [];
  let used = 0;
  for (const w of wanted) {
    if (used >= MAX_CHARS) { truncated = true; break; }
    const p = w === undefined ? first : await documentPageText(db, doc.id, w);
    if (!p) throw notFound();
    const text = p.text.slice(0, MAX_CHARS - used);
    if (text.length < p.text.length) truncated = true;
    used += text.length;
    pages.push({ page: p.page, text });
  }
  return { documentId: doc.id, filename: doc.filename, pages, truncated };
}
