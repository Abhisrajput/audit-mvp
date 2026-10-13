import type { SignableWorkpaper } from '../agents/types';
import type { Executor } from './trail-repo';

export interface SignatureRow {
  id: string;
  engagementId: string;
  /** The finding signed; null for a workpaper gate signature. */
  findingId: string | null;
  subjectKind: 'finding' | 'workpaper';
  workpaper: SignableWorkpaper | null;
  gateId: string | null;
  userId: string;
  userName: string;
  role: string;
  meaning: 'Reviewed' | 'Approved' | 'Rejected';
  comment: string;
  contentHash: string;
  reauthMethod: 'oidc' | 'dev' | 'none';
  reauthAt: string | null;
  intentId: string | null;
  trailBundleId: string;
  signedAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export async function insertSignature(db: Executor, s: SignatureRow): Promise<void> {
  await db
    .insertInto('signatures')
    .values({
      id: s.id, engagement_id: s.engagementId, finding_id: s.findingId, subject_kind: s.subjectKind, workpaper: s.workpaper, gate_id: s.gateId,
      user_id: s.userId, user_name: s.userName, role: s.role, meaning: s.meaning, comment: s.comment, content_hash: s.contentHash,
      reauth_method: s.reauthMethod, reauth_at: s.reauthAt, intent_id: s.intentId, trail_bundle_id: s.trailBundleId, signed_at: s.signedAt,
    })
    .execute();
}

export async function listSignatures(db: Executor, engagementId: string): Promise<SignatureRow[]> {
  const rows = await db.selectFrom('signatures').selectAll().where('engagement_id', '=', engagementId).orderBy('signed_at').orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id, engagementId: r.engagement_id, findingId: r.finding_id, subjectKind: r.subject_kind, workpaper: r.workpaper, gateId: r.gate_id,
    userId: r.user_id, userName: r.user_name, role: r.role, meaning: r.meaning, comment: r.comment, contentHash: r.content_hash,
    reauthMethod: r.reauth_method, reauthAt: r.reauth_at ? iso(r.reauth_at) : null, intentId: r.intent_id, trailBundleId: r.trail_bundle_id,
    signedAt: iso(r.signed_at),
  }));
}
