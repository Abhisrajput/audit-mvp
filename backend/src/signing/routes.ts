import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DEV_ISSUER } from '../auth/dev-users';
import { actorOf, requireRole } from '../auth/http';
import { page } from '../auth/page';
import { READ_ROLES } from '../auth/roles';
import type { AuthDeps } from '../auth/routes';
import { getUser } from '../auth/user-repo';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuditService } from '../service';
import { completeSigning, failIntent, REAUTH_MAX_AGE_MS } from './flow';
import { createIntent, getIntent, getIntentByState } from './intent-repo';
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
    res.status(201).json({ intentId: intent.id, reauthUrl: `/auth/sign/${intent.id}`, method, expiresAt: intent.expiresAt });
  }));

  r.get('/api/sign-intents/:intentId', wrap(async (req, res) => {
    const intent = await getIntent(db, String(req.params.intentId));
    if (!intent || intent.userId !== req.auth!.user.id) throw new AppError(404, 'Signing request not found');
    res.json({ status: intent.status, code: intent.failureCode, message: intent.failureMessage });
  }));

  // The pop-up opens here (same origin, so the session cookie is sent).
  r.get('/auth/sign/:intentId', wrap(async (req, res) => {
    const user = req.auth?.user;
    const intent = await getIntent(db, String(req.params.intentId));
    if (!user || !intent || intent.userId !== user.id) return page(res, 404, 'Signing request not found', 'Start signing again from the finding.');
    if (intent.status !== 'pending' || Date.now() > Date.parse(intent.expiresAt)) {
      return page(res, 410, 'Signing request expired', 'Start signing again from the finding.');
    }
    const method = reauthMethodFor(user.issuer);
    if (method === 'oidc') return res.redirect(await auth.oidc!.reauthUrl({ state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier }));
    if (method === 'dev') return devConfirmPage(res, intent, user.name);
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
      if (!user.role) return page(res, 403, 'Cannot sign', 'Your account has no role.');
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

    const user = await getUser(db, intent.userId);
    if (!user || !user.active || !user.role) {
      resultPage(res, { ok: false, code: 'REAUTH_REQUIRED', message: 'This account can no longer sign.' });
      return true;
    }
    const actor = { id: user.id, name: user.name, role: user.role };
    const callbackUrl = new URL(cfg.oidc.redirectUri);
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);

    let identity;
    try {
      identity = await auth.oidc.finish(callbackUrl, { state: intent.state, nonce: intent.nonce, codeVerifier: intent.codeVerifier });
    } catch (err) {
      console.warn('Signing re-authentication rejected:', err instanceof Error ? err.message : err);
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_REQUIRED', 'Re-authentication could not be verified. Try again.'));
      return true;
    }
    if (identity.issuer !== user.issuer || identity.subject !== user.subject) {
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_USER_MISMATCH', 'You re-authenticated as a different person.'));
      return true;
    }
    if (identity.authTime === null || Date.now() - identity.authTime * 1000 > REAUTH_MAX_AGE_MS) {
      resultPage(res, await failIntent(svc, intent, actor, 'REAUTH_STALE', 'Your identity provider did not ask for your password just now. Try again.'));
      return true;
    }
    resultPage(res, await completeSigning(svc, intent, actor, { method: 'oidc', at: new Date(identity.authTime * 1000).toISOString() }));
    return true;
  }

  return { router: r, handleIdpCallback };
}
