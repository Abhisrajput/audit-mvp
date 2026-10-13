import crypto from 'node:crypto';
import type { SignableWorkpaper } from '../agents/types';
import type { Selectable } from 'kysely';
import type { SignIntentsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import type { SignAction } from '../service';

export interface SignIntent {
  id: string;
  userId: string;
  engagementId: string;
  /** What is being signed: a finding, or the workpaper of a scope, RCM or report gate. */
  subjectKind: 'finding' | 'workpaper';
  findingId: string | null;
  workpaper: SignableWorkpaper | null;
  gateId: string | null;
  action: SignAction;
  comment: string;
  contentHash: string;
  /** One-time OIDC values for this request's re-authentication. */
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'signed' | 'failed';
  failureCode: string | null;
  failureMessage: string | null;
}

/** A signing request must be completed within five minutes. */
export const INTENT_TTL_MS = 5 * 60_000;

const token = () => crypto.randomBytes(32).toString('base64url');
const iso = (d: Date | string) => new Date(d).toISOString();

function toIntent(r: Selectable<SignIntentsTable>): SignIntent {
  return {
    id: r.id, userId: r.user_id, engagementId: r.engagement_id, subjectKind: r.subject_kind, findingId: r.finding_id, workpaper: r.workpaper,
    gateId: r.gate_id, action: r.action, comment: r.comment, contentHash: r.content_hash, state: r.state, nonce: r.nonce,
    codeVerifier: r.code_verifier, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), status: r.status,
    failureCode: r.failure_code, failureMessage: r.failure_message,
  };
}

export type IntentSubject = { findingId: string } | { gateId: string; workpaper: SignableWorkpaper };

export async function createIntent(
  db: Executor,
  p: { userId: string; engagementId: string; action: SignAction; comment: string; contentHash: string } & IntentSubject,
  now = new Date(),
): Promise<SignIntent> {
  const subject = 'gateId' in p
    ? { subject_kind: 'workpaper' as const, finding_id: null, workpaper: p.workpaper, gate_id: p.gateId }
    : { subject_kind: 'finding' as const, finding_id: p.findingId, workpaper: null, gate_id: null };
  const row = await db
    .insertInto('sign_intents')
    .values({
      id: `INT-${crypto.randomBytes(8).toString('hex')}`, user_id: p.userId, engagement_id: p.engagementId, ...subject,
      action: p.action, comment: p.comment, content_hash: p.contentHash, state: token(), nonce: token(), code_verifier: token(),
      expires_at: new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toIntent(row);
}

export async function getIntent(db: Executor, id: string): Promise<SignIntent | null> {
  const row = await db.selectFrom('sign_intents').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toIntent(row) : null;
}

export async function getIntentByState(db: Executor, state: string): Promise<SignIntent | null> {
  const row = await db.selectFrom('sign_intents').selectAll().where('state', '=', state).executeTakeFirst();
  return row ? toIntent(row) : null;
}

/** Takes a pending request for completion. Only one caller can ever succeed. */
export async function claimIntent(db: Executor, id: string): Promise<boolean> {
  const res = await db.updateTable('sign_intents').set({ status: 'claimed' }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

/**
 * Records how a request ended. Only a request still in one of `from` changes, so a request
 * that was signed is never marked failed, and a cancel never overtakes a claim. Returns whether it changed.
 */
export async function finishIntent(
  db: Executor,
  id: string,
  outcome: { status: 'signed' } | { status: 'failed'; code: string; message: string },
  from: readonly ('pending' | 'claimed')[] = ['pending', 'claimed'],
): Promise<boolean> {
  const res = await db
    .updateTable('sign_intents')
    .set({
      status: outcome.status,
      failure_code: outcome.status === 'failed' ? outcome.code : null,
      failure_message: outcome.status === 'failed' ? outcome.message : null,
      completed_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .where('status', 'in', [...from])
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}
