import type { Transaction } from 'kysely';
import { recordIdentityEvent } from '../auth/identity-trail';
import type { DB } from '../db/schema';
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
 * Only a request still in one of `from` is failed. The default, ['pending'], is for checks that run before this
 * attempt claimed the request: if another attempt claimed (or finished) it meanwhile, it is left alone and the
 * late failure is trailed as a replay. Only completeSigning, after its own claim, passes ['claimed'].
 */
export async function failIntent(
  svc: AuditService,
  intent: SignIntent,
  actor: Actor,
  code: ErrorCode,
  message: string,
  from: readonly ('pending' | 'claimed')[] = ['pending'],
): Promise<SignOutcome> {
  await svc.db.kysely.transaction().execute(async (trx) => {
    if (await finishIntent(trx, intent.id, { status: 'failed', code, message }, from)) {
      await recordIdentityEvent(trx, 'sign-failed', actor, inputsOf(intent), { code, message });
    } else {
      await recordReplay(trx, intent, actor, code, message);
    }
  });
  return { ok: false, code, message };
}

/**
 * Trails an attempt on a request that had already moved on (claimed by another attempt, signed or failed).
 * The request itself is left as it is; the entry is marked as a replay so it never reads as a failed signature.
 */
async function recordReplay(trx: Transaction<DB>, intent: SignIntent, actor: Actor, code: ErrorCode, message: string): Promise<void> {
  const current = await getIntent(trx, intent.id);
  await recordIdentityEvent(trx, 'sign-failed', actor, inputsOf(intent), { code, message, replay: true, intentStatus: current?.status ?? null });
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
    const lost = { ok: false, code: 'INTENT_EXPIRED', message: 'This signing request has already been used. Start signing again from the finding.' } as const;
    await svc.db.kysely.transaction().execute((trx) => recordReplay(trx, intent, actor, lost.code, lost.message));
    return lost;
  }
  // From here this attempt owns the request, so its failures move it from 'claimed'.
  const CLAIMED = ['claimed'] as const;
  if (now.getTime() > Date.parse(intent.expiresAt)) {
    return failIntent(svc, intent, actor, 'INTENT_EXPIRED', 'The signing request expired. Start signing again from the finding.', CLAIMED);
  }
  try {
    await svc.signOff(intent.engagementId, intent.findingId, intent.action, intent.comment, actor, {}, {
      contentHash: intent.contentHash, reauthMethod: reauth.method, reauthAt: reauth.at, intentId: intent.id,
    });
  } catch (err) {
    if (err instanceof AppError) return failIntent(svc, intent, actor, err.code, err.message, CLAIMED);
    await failIntent(svc, intent, actor, 'INTERNAL', 'Signing failed unexpectedly.', CLAIMED);
    throw err;
  }
  return { ok: true };
}
