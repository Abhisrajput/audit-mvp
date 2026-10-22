import { sql, type RawBuilder } from 'kysely';
import type { Executor } from '../db/trail-repo';
import { tidyLinks } from '../engine/evidence';
import type { EvidenceLink, User } from '../engine/types';
import { AppError } from '../errors';
import { mayRead } from '../knowledge/access';
import { getDocument } from '../knowledge/document-repo';

export { changedLinks, hasEvidence, normaliseEvidence } from '../engine/evidence';

const notFound = (id: string) => new AppError(400, `Evidence document ${id} was not found`, 'EVIDENCE_NOT_FOUND');

/**
 * Checks each link against the registry as the actor sees it and returns the links with duplicates removed and notes
 * trimmed. A document that is missing, on another engagement or above the actor's clearance is refused with the same
 * answer, so a link cannot be used to find out what exists.
 */
export async function resolveEvidence(db: Executor, links: EvidenceLink[], scope: { engagementId: string; actor: User }): Promise<EvidenceLink[]> {
  const resolved: EvidenceLink[] = [];
  for (const l of tidyLinks(links)) {
    const doc = await getDocument(db, l.documentId);
    if (!doc || (doc.engagementId !== null && doc.engagementId !== scope.engagementId) || !mayRead(scope.actor.role, doc.classification)) throw notFound(l.documentId);
    if (doc.retentionExpired) throw new AppError(400, `Evidence document ${l.documentId} has passed its retention date and cannot be newly linked`, 'EVIDENCE_EXPIRED');
    const pages = doc.extraction?.pages;
    if (l.page !== undefined && typeof pages === 'number' && l.page > pages) throw new AppError(400, `Evidence document ${l.documentId} has ${pages} page(s); page ${l.page} does not exist`);
    resolved.push(l);
  }
  return resolved;
}

const cites = (id: string) => sql`jsonb_build_array(jsonb_build_object('documentId', ${id}::text))`;

/** The tests and live findings that cite one document. */
export async function documentUsage(db: Executor, documentId: string): Promise<{ tests: { engagementId: string; rowId: string }[]; findings: { engagementId: string; findingId: string }[] }> {
  const tests = await sql<{ engagement_id: string; row_id: string }>`
    SELECT w.engagement_id, kv.key AS row_id FROM engagement_work w, jsonb_each(w.test_inputs) kv
    WHERE kv.value->'evidence' @> ${cites(documentId)} ORDER BY w.engagement_id, kv.key`.execute(db);
  const findings = await sql<{ engagement_id: string; id: string }>`
    SELECT engagement_id, id FROM findings WHERE superseded_at IS NULL AND data->'evidence' @> ${cites(documentId)} ORDER BY engagement_id, id`.execute(db);
  return {
    tests: tests.rows.map((r) => ({ engagementId: r.engagement_id, rowId: r.row_id })),
    findings: findings.rows.map((r) => ({ engagementId: r.engagement_id, findingId: r.id })),
  };
}

/**
 * SQL predicate: some test record or any finding version (superseded ones included) cites the document whose id
 * `docId` evaluates to. Shared by linkedDocumentIds and the retention UPDATE so the two cannot drift.
 */
export const citedByRecord = (docId: RawBuilder<unknown>) => sql<boolean>`(
  EXISTS (SELECT 1 FROM engagement_work w, jsonb_each(w.test_inputs) kv, jsonb_array_elements(CASE WHEN jsonb_typeof(kv.value->'evidence') = 'array' THEN kv.value->'evidence' ELSE '[]'::jsonb END) e WHERE e->>'documentId' = ${docId})
  OR EXISTS (SELECT 1 FROM findings f, jsonb_array_elements(CASE WHEN jsonb_typeof(f.data->'evidence') = 'array' THEN f.data->'evidence' ELSE '[]'::jsonb END) e WHERE e->>'documentId' = ${docId})
)`;

/** Every document id cited by any test record or any finding version, superseded ones included (retention must not release a document a signed version cites). */
export async function linkedDocumentIds(db: Executor): Promise<Set<string>> {
  const rows = await sql<{ id: string }>`SELECT d.id FROM documents d WHERE ${citedByRecord(sql`d.id`)}`.execute(db);
  return new Set(rows.rows.map((r) => r.id));
}

/** File names for the given document ids, for the report to print. Ids not in the registry are left out. */
export async function documentNamesFor(db: Executor, ids: string[]): Promise<Map<string, { filename: string }>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.selectFrom('documents').select(['id', 'filename']).where('id', 'in', unique).execute();
  return new Map(rows.map((r) => [r.id, { filename: r.filename }]));
}
