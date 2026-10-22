import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { citedByRecord } from './links';

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
  // One statement: a link recorded between a scan and an update cannot be expired by this run.
  const expired = await sql<{ id: string }>`
    UPDATE documents SET retention_expired = true
    WHERE retain_until < ${today}::date AND NOT retention_expired AND NOT ${citedByRecord(sql`documents.id`)}
    RETURNING id`.execute(db);
  const left = await db.selectFrom('documents').select('id').where(sql<boolean>`retain_until < ${today}::date`).where('retention_expired', '=', false).orderBy('id').execute();
  return { expired: expired.rows.map((r) => r.id).sort(), retainedByRecord: left.map((r) => r.id) };
}
