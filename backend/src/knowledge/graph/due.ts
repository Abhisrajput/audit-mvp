import type { Executor } from '../../db/trail-repo';
import { todayUtc, trustProblems } from '../../engine/trust';

// The "due for re-review" list (spec §6.4, §9): active library concepts nobody has verified yet,
// or whose re-review date has arrived. Metadata only, so administrators see no audit content.
// The status of each concept comes from the trust rules (trustProblems), not a second copy of them.

export interface DueConcept {
  nodeId: string;
  conceptId: string;
  type: string;
  packId: string;
  packVersion: string;
  title: string;
  sourcePath: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  staleAfter: string | null;
  reasons: ('unverified' | 'stale')[];
}

export async function knowledgeDue(db: Executor, today = todayUtc()): Promise<DueConcept[]> {
  const rows = await db
    .selectFrom('kg_nodes')
    .select(['id', 'concept_id', 'type', 'pack_id', 'pack_version', 'title', 'source_path', 'verified_by', 'verified_role', 'verified_at', 'stale_after'])
    .where('status', '=', 'active')
    .where('type', 'in', ['regulation', 'clause', 'control', 'risk'])
    .where((eb) => eb.or([eb('verified_by', 'is', null), eb('stale_after', '<=', today)]))
    .orderBy('pack_id').orderBy('type').orderBy('concept_id')
    .execute();
  return rows.map((r) => ({
    nodeId: r.id, conceptId: r.concept_id, type: r.type, packId: r.pack_id, packVersion: r.pack_version, title: r.title,
    sourcePath: r.source_path, verifiedBy: r.verified_by, verifiedAt: r.verified_at, staleAfter: r.stale_after,
    reasons: trustProblems(
      { nodeId: r.id, verifiedBy: r.verified_by, verifiedRole: r.verified_role, verifiedAt: r.verified_at, status: 'active', staleAfter: r.stale_after, sourcePath: r.source_path },
      today,
    ).map((p) => (p === 'UNVERIFIED_SOURCE' ? ('unverified' as const) : ('stale' as const))),
  }));
}
