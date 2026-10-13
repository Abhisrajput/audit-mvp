import type { WorkpaperKind } from '../agents/types';
import type { Engagement, Finding } from '../engine/types';
import { findingContentHash, workpaperContentHash } from '../signing/content-hash';
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

/** When each finding of an engagement last had its content change: finding id → ISO time of its latest revision. */
export async function lastRevisionTimes(db: Executor, engagementId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('finding_revisions')
    .select(['finding_id'])
    .select((eb) => eb.fn.max('recorded_at').as('last'))
    .where('engagement_id', '=', engagementId)
    .groupBy('finding_id')
    .execute();
  return new Map(rows.map((r) => [r.finding_id, new Date(r.last as unknown as string).toISOString()]));
}

export const WORKPAPER_KINDS: readonly WorkpaperKind[] = ['scope', 'rcm', 'test_plans', 'report'];

const isEmpty = (kind: WorkpaperKind, e: Engagement) =>
  kind === 'scope' ? !e.scope.length : kind === 'rcm' ? !e.rcm.length : kind === 'test_plans' ? !Object.keys(e.testPlans ?? {}).length : !e.report;

/** Appends a revision for each workpaper whose content differs from its latest recorded revision. Empty workpapers are skipped. */
export async function recordWorkpaperRevisions(db: Executor, e: Engagement): Promise<void> {
  for (const kind of WORKPAPER_KINDS) {
    if (isEmpty(kind, e)) continue;
    const hash = workpaperContentHash(kind, e);
    const last = await db
      .selectFrom('workpaper_revisions')
      .select(['revision', 'content_hash'])
      .where('engagement_id', '=', e.id)
      .where('kind', '=', kind)
      .orderBy('revision', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (last?.content_hash === hash) continue;
    await db
      .insertInto('workpaper_revisions')
      .values({ engagement_id: e.id, kind, revision: (last?.revision ?? 0) + 1, content_hash: hash })
      .execute();
  }
}
