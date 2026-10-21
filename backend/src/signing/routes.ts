import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { openGateForSubject } from '../agents/gate-repo';
import { DEV_ISSUER } from '../auth/dev-users';
import { actorOf, requireRole } from '../auth/http';
import { page, popupHeaders } from '../auth/page';
import { READ_ROLES } from '../auth/roles';
import type { AuthDeps } from '../auth/routes';
import { getUser } from '../auth/user-repo';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { completeSigning, failIntent, NO_LONGER_VALID, REAUTH_MAX_AGE_MS, SKEW_MS } from './flow';
import { createIntent, getIntent, getIntentByState, type SignIntent } from './intent-repo';
import { devConfirmPage, resultPage } from './pages';

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Part 11 signing: a signing request, re-authentication in a pop-up, then the signature. */
export function signingRoutes(svc: AuditService, auth: AuthDeps) {
  const cfg = auth.config;
  const db = svc.db.kysely;
  const r = Router();
  const readers = requireRole(READ_ROLES);

  const reauthMethodFor = (issuer: string): 'oidc' | 'dev' | null =>
    issuer === DEV_ISSUER ? (cfg.devAuth ? 'dev' : null) : auth.oidc ? 'oidc' : null;

  // Under /api, so the session, CSRF and role gates in app.ts already apply.
  r.post('/api/engagements/:id/findings/:fid/sign-intents', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['review', 'approve', 'reject']), comment: z.string().max(2000).default('') }).parse(req.body);
    const actor = actorOf(req);
    const engagementId = String(req.params.id);
    const findingId = String(req.params.fid);
    const { contentHash } = await svc.checkSignOff(engagementId, findingId, body.action, actor);
    const method = reauthMethodFor(req.auth!.user.issuer);
    if (!method) throw new AppError(409, 'No way to re-authenticate is configured for your account; ask your administrator', 'REAUTH_REQUIRED');
    const intent = await createIntent(db, { userId: actor.id, engagementId, findingId, action: body.action, comment: body.comment, contentHash });
    // An agent-drafted finding is under a gate: its reviewer sees the QA report that gate carries,
    // but only if the gate was opened on the content being signed (agent spec REQ-30).
    const gate = await openGateForSubject(db, engagementId, findingId);
    res.status(201).json({ intentId: intent.id, reauthUrl: `/auth/sign/${intent.id}`, method, expiresAt: intent.expiresAt, qa: gate && gate.subjectHash === contentHash ? gate.qaReport : null });
  }));

  // A scope, RCM or report gate the agent opened (agent spec §4.3). Rejecting needs a reason: the agent redrafts from it.
  r.post('/api/gates/:gateId/sign-intents', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['approve', 'reject']), comment: z.string().max(2000).default('') }).parse(req.body);
    if (body.action === 'reject' && !body.comment.trim()) throw new AppError(400, 'Say why you are rejecting this workpaper: the agent redrafts it from your comment');
    const actor = actorOf(req);
    const gateId = String(req.params.gateId);
    const { engagementId, workpaper, contentHash, qaReport } = await svc.checkGateSignOff(gateId, actor);
    const method = reauthMethodFor(req.auth!.user.issuer);
    if (!method) throw new AppError(409, 'No way to re-authenticate is configured for your account; ask your administrator', 'REAUTH_REQUIRED');
    const intent = await createIntent(db, { userId: actor.id, engagementId, gateId, workpaper, action: body.action, comment: body.comment, contentHash });
    res.status(201).json({ intentId: intent.id, reauthUrl: `/auth/sign/${intent.id}`, method, expiresAt: intent.expiresAt, qa: qaReport });
  }));

  const statusOf = (intent: SignIntent) => ({ status: intent.status, code: intent.failureCode, message: intent.failureMessage });
  const ownIntent = async (req: Request) => {
    const intent = await getIntent(db, String(req.params.intentId));
    if (!intent || intent.userId !== req.auth!.user.id) throw new AppError(404, 'Signing request not found');
    return intent;
  };

  r.get('/api/sign-intents/:intentId', wrap(async (req, res) => {
    res.json(statusOf(await ownIntent(req)));
  }));

  // The app gave up waiting: the signer cancelled (CANCELLED), or the request ran out (`reason: 'expired'`, INTENT_EXPIRED).
  // Only a request nobody has started completing is cancelled.
  r.post('/api/sign-intents/:intentId/cancel', wrap(async (req, res) => {
    const { reason } = z.object({ reason: z.enum(['expired']).optional() }).parse(req.body ?? {});
    const intent = await ownIntent(req);
    const { id, name, role } = req.auth!.user;
    if (intent.status === 'pending') {
      const [code, message] = reason === 'expired'
        ? ['INTENT_EXPIRED', 'The signing request expired before re-authentication finished'] as const
        : ['CANCELLED', 'Cancelled before re-authentication finished'] as const;
      await failIntent(svc, intent, { id, name, role }, code, message, ['pending']);
    }
    res.json(statusOf((await getIntent(db, intent.id))!));
  }));

  /** A request that already ended, or ran out, cannot be used. Expiry is recorded; reuse of an ended request is not. */
  async function unusable(intent: SignIntent, actor: { id: string; name: string; role: string | null }) {
    if (intent.status !== 'pending') return NO_LONGER_VALID;
    if (Date.now() > Date.parse(intent.expiresAt)) {
      return failIntent(svc, intent, actor, 'INTENT_EXPIRED', 'The signing request expired. Start signing again from the finding.');
    }
    return null;
  }

  // The pop-up opens here (same origin, so the session cookie is sent).
  r.get('/auth/sign/:intentId', wrap(async (req, res) => {
    const user = req.auth?.user;
    const intent = await getIntent(db, String(req.params.intentId));
    if (!user || !intent || intent.userId !== user.id) return page(res, 404, 'Signing request not found', 'Start signing again from the finding.');
    if (intent.status !== 'pending' || Date.now() > Date.parse(intent.expiresAt)) {
      return page(res, 410, 'Signing request expired', 'Start signing again from the finding.');
    }
    const method = reauthMethodFor(user.issuer);
    popupHeaders(res);
    if (method === 'oidc') return res.redirect(await auth.oidc!.reauthUrl({ state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier }));
    if (method === 'dev') return devConfirmPage(res, intent, user.name, user.id);
    return page(res, 409, 'Cannot re-authenticate', 'No way to re-authenticate is configured for your account.');
  }));

  if (cfg.devAuth) {
    // A plain form post from the pop-up. The intent's secret nonce, only ever shown to its owner, stands in for the CSRF header.
    r.post('/auth/sign/:intentId/dev', express.urlencoded({ extended: false }), wrap(async (req, res) => {
      const user = req.auth?.user;
      const intent = await getIntent(db, String(req.params.intentId));
      if (!user || !intent || intent.userId !== user.id || !sameToken(String(req.body?.nonce ?? ''), intent.nonce)) {
        return page(res, 404, 'Signing request not found', 'Start signing again from the finding.');
      }
      const ended = await unusable(intent, user);
      if (ended) return resultPage(res, ended);
      if (!user.role) return resultPage(res, await failIntent(svc, intent, user, 'REAUTH_REQUIRED', 'Your account has no role, so it cannot sign.'));
      const actor = { id: user.id, name: user.name, role: user.role };
      if (user.issuer !== DEV_ISSUER || String(req.body?.confirm ?? '') !== user.id) {
        return resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_USER_MISMATCH', 'The identity you confirmed is not the signed-in user.'));
      }
      resultPage(res, await completeSigning(svc, intent, actor, { method: 'dev', at: new Date().toISOString() }));
    }));
  }

  /**
   * Called first by /auth/callback. When the identity provider's answer belongs to a
   * signing request (matched by state), verify it and sign; return false otherwise.
   * The session cookie is not needed (and is absent on this cross-site redirect): the
   * request names the signer, and the ID token must prove it is them, just now.
   */
  async function handleIdpCallback(req: Request, res: Response): Promise<boolean> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const intent = state ? await getIntentByState(db, state) : null;
    if (!intent || !auth.oidc || !cfg.oidc) return false;
    // A replayed or late callback is turned away before the identity provider is asked anything, and is not trailed.
    if (intent.status !== 'pending') {
      resultPage(res, NO_LONGER_VALID);
      return true;
    }

    const user = await getUser(db, intent.userId);
    const signer = user ? { id: user.id, name: user.name, role: user.role } : { id: intent.userId, name: intent.userId, role: null };
    const ended = await unusable(intent, signer);
    if (ended) {
      resultPage(res, ended);
      return true;
    }
    if (!user || !user.active || !user.role) {
      resultPage(res, await failIntent(svc, intent, signer, 'REAUTH_REQUIRED', 'This account can no longer sign.'));
      return true;
    }
    const actor = { id: user.id, name: user.name, role: user.role };
    const callbackUrl = new URL(cfg.oidc.redirectUri);
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);

    let identity;
    try {
      identity = await auth.oidc.finish(callbackUrl, { state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier });
    } catch (err) {
      logger.warn({ err }, 'Signing re-authentication rejected');
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_REQUIRED', 'Re-authentication could not be verified. Try again.'));
      return true;
    }
    if (identity.issuer !== user.issuer || identity.subject !== user.subject) {
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_USER_MISMATCH', 'You re-authenticated as a different person.'));
      return true;
    }
    // auth_time must fall after this request was made (an IdP that ignores prompt=login / max_age=0 reuses an older
    // sign-in), not in the future, and within the last two minutes.
    const stale = (message: string) => failIntent(svc, intent, actor, 'REAUTH_STALE', message);
    if (identity.authTime === null) {
      logger.warn('Signing re-authentication refused: the identity provider sent no auth_time claim. Enable the auth_time claim in the ID token.');
      resultPage(res, await stale('Your identity provider did not report when you signed in (auth_time); ask your administrator to enable it.'));
      return true;
    }
    const authMs = identity.authTime * 1000;
    const now = Date.now();
    if (authMs < Date.parse(intent.createdAt) - SKEW_MS) {
      resultPage(res, await stale('Your identity provider reused an earlier sign-in instead of asking for your password. Try again; if this keeps happening, ask your administrator to make the identity provider honour prompt=login.'));
      return true;
    }
    if (authMs > now + SKEW_MS) {
      resultPage(res, await stale('Your identity provider reported a sign-in time in the future. Ask your administrator to check the server clocks, then try again.'));
      return true;
    }
    if (now - authMs > REAUTH_MAX_AGE_MS) {
      resultPage(res, await stale('Your identity provider did not ask for your password just now. Try again.'));
      return true;
    }
    resultPage(res, await completeSigning(svc, intent, actor, { method: 'oidc', at: new Date(identity.authTime * 1000).toISOString() }));
    return true;
  }

  return { router: r, handleIdpCallback };
}
