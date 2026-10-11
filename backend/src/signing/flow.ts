import { recordIdentityEvent } from '../auth/identity-trail';
import type { User } from '../engine/types';
import { AppError, type ErrorCode } from '../errors';
import type { AuditService } from '../service';
import { claimIntent, finishIntent, getIntent, type SignIntent } from './intent-repo';

/** The signer must have authenticated at the identity provider at most this long before the callback (spec §4.4). */
export const REAUTH_MAX_AGE_MS = 120_000;
/** Allowed clock difference between us and the identity provider when comparing auth_time with the request. */
export const SKEW_MS = 10_000;

export type SignOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string };
type Actor = { id: string; name: string; role: string | null };

const inputsOf = (intent: SignIntent) => ({ intentId: intent.id, engagementId: intent.engagementId, findingId: intent.findingId, action: intent.action });

/** Shown when a request that already ended (or is being completed) is used again. Nothing is recorded for it. */
export const NO_LONGER_VALID: SignOutcome = {
  ok: false, code: 'INTENT_EXPIRED', message: 'This signing request is no longer valid. Start signing again from the finding.',
};

/**
 * Records a failed signing attempt on the request and in the audit trail, together.
 * Only a request still in one of `from` is failed; if it already moved on (signed, failed,
 * or claimed when `from` is ['pending']), nothing is written.
 */
export async function failIntent(
  svc: AuditService,
  intent: SignIntent,
  actor: Actor,
  code: ErrorCode,
  message: string,
  from: readonly ('pending' | 'claimed')[] = ['pending', 'claimed'],
): Promise<SignOutcome> {
  await svc.db.kysely.transaction().execute(async (trx) => {
    if (await finishIntent(trx, intent.id, { status: 'failed', code, message }, from)) {
      await recordIdentityEvent(trx, 'sign-failed', actor, inputsOf(intent), { code, message });
    }
  });
  return { ok: false, code, message };
}

/** Trails an attempt to complete a request someone else already took. The request itself is left as it is. */
async function recordReplay(svc: AuditService, intent: SignIntent, actor: Actor): Promise<void> {
  const current = await getIntent(svc.db.kysely, intent.id);
  await svc.db.kysely.transaction().execute((trx) =>
    recordIdentityEvent(trx, 'sign-failed', actor, inputsOf(intent), { code: 'INTENT_EXPIRED', replay: true, intentStatus: current?.status ?? null }),
  );
}

/**
 * Turns a re-authenticated signing request into a signature, at most once.
 * The request is marked signed inside the signature's own transaction (service.signOff).
 */
export async function completeSigning(
  svc: AuditService,
  intent: SignIntent,
  actor: User,
  reauth: { method: 'oidc' | 'dev'; at: string },
  now = new Date(),
): Promise<SignOutcome> {
  if (!(await claimIntent(svc.db.kysely, intent.id))) {
    await recordReplay(svc, intent, actor);
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
  return { ok: true };
}
