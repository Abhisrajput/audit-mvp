import type { Finding } from '../engine/types';
import { findingContentHash } from '../signing/content-hash';
import type { Executor } from './trail-repo';

export interface FindingRevision {
  revision: number;
  contentHash: string;
  recordedAt: string;
}

/** Appends a revision when the finding's content differs from its latest recorded revision. */
export async function recordRevision(db: Executor, engagementId: string, f: Finding): Promise<void> {
  const hash = findingContentHash(f);
  const last = await db
    .selectFrom('finding_revisions')
    .select(['revision', 'content_hash'])
    .where('engagement_id', '=', engagementId)
    .where('finding_id', '=', f.id)
    .orderBy('revision', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (last?.content_hash === hash) return;
  await db
    .insertInto('finding_revisions')
    .values({ engagement_id: engagementId, finding_id: f.id, revision: (last?.revision ?? 0) + 1, content_hash: hash })
    .execute();
}

export async function listRevisions(db: Executor, engagementId: string, findingId: string): Promise<FindingRevision[]> {
  const rows = await db
    .selectFrom('finding_revisions')
    .select(['revision', 'content_hash', 'recorded_at'])
    .where('engagement_id', '=', engagementId)
    .where('finding_id', '=', findingId)
    .orderBy('revision')
    .execute();
  return rows.map((r) => ({ revision: r.revision, contentHash: r.content_hash, recordedAt: new Date(r.recorded_at).toISOString() }));
}
