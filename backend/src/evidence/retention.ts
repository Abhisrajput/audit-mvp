import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { linkedDocumentIds } from './links';

export interface RetentionResult {
  /** documents hidden by this run */
  expired: string[];
  /** documents past their date that a test record or finding (any version) still cites; left untouched */
  retainedByRecord: string[];
}

/**
 * Marks documents whose retain_until is before `today` (YYYY-MM-DD, compared as a calendar date) as retention_expired.
 * Documents cited by a test record or any finding version are never expired here. Nothing is deleted; a second run is a no-op.
 * Needs the owner role: audit_api cannot update documents.
 */
export async function runRetention(db: Kysely<DB>, today: string): Promise<RetentionResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
  const rows = await db.selectFrom('documents').select('id').where(sql<boolean>`retain_until < ${today}::date`).where('retention_expired', '=', false).orderBy('id').execute();
  const linked = await linkedDocumentIds(db);
  const retainedByRecord = rows.map((r) => r.id).filter((id) => linked.has(id));
  const expired = rows.map((r) => r.id).filter((id) => !linked.has(id));
  if (expired.length) await db.updateTable('documents').set({ retention_expired: true }).where('id', 'in', expired).where('retention_expired', '=', false).execute();
  return { expired, retainedByRecord };
}
