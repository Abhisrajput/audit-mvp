import { recordIdentityEvent } from '../auth/identity-trail';
import type { User } from '../engine/types';
import { AppError, type ErrorCode } from '../errors';
import type { AuditService } from '../service';
import { claimIntent, finishIntent, type SignIntent } from './intent-repo';

/** The signer must have authenticated at the identity provider at most this long before the callback (spec §4.4). */
export const REAUTH_MAX_AGE_MS = 120_000;

export type SignOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Records a failed signing attempt on the request and in the audit trail. */
export async function failIntent(
  svc: AuditService,
  intent: SignIntent,
  actor: { id: string; name: string; role: string | null },
  code: ErrorCode,
  message: string,
): Promise<SignOutcome> {
  await svc.db.kysely.transaction().execute(async (trx) => {
    await finishIntent(trx, intent.id, { status: 'failed', code, message });
    await recordIdentityEvent(trx, 'sign-failed', actor, { intentId: intent.id, engagementId: intent.engagementId, findingId: intent.findingId, action: intent.action }, { code, message });
  });
  return { ok: false, code, message };
}

/** Turns a re-authenticated signing request into a signature, at most once. */
export async function completeSigning(
  svc: AuditService,
  intent: SignIntent,
  actor: User,
  reauth: { method: 'oidc' | 'dev'; at: string },
  now = new Date(),
): Promise<SignOutcome> {
  if (!(await claimIntent(svc.db.kysely, intent.id))) {
    return { ok: false, code: 'INTENT_EXPIRED', message: 'This signing request has already been used. Start signing again from the finding.' };
  }
  if (now.getTime() > Date.parse(intent.expiresAt)) {
    return failIntent(svc, intent, actor, 'INTENT_EXPIRED', 'The signing request expired. Start signing again from the finding.');
  }
  try {
    await svc.signOff(intent.engagementId, intent.findingId, intent.action, intent.comment, actor, {}, {
      contentHash: intent.contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: intent.id,
    });
  } catch (err) {
    if (err instanceof AppError) return failIntent(svc, intent, actor, err.code, err.message);
    await failIntent(svc, intent, actor, 'INTERNAL', 'Signing failed unexpectedly.');
    throw err;
  }
  await finishIntent(svc.db.kysely, intent.id, { status: 'signed' });
  return { ok: true };
}
