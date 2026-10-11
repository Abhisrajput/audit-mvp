import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuthConfig } from './config';
import { DEV_ISSUER, DEV_USERS } from './dev-users';
import { clearSessionCookie, requireUser, SESSION_COOKIE, setSessionCookie } from './http';
import { recordIdentityEvent } from './identity-trail';
import { createSession, revokeSession } from './session-repo';
import type { OidcChecks, OidcClient } from './oidc';
import { roleFromGroups } from './oidc';
import { getUser, provisionUser, type UserRecord } from './user-repo';

export interface AuthDeps {
  config: AuthConfig;
  /** null when no identity provider is configured (DEV_AUTH only). */
  oidc: OidcClient | null;
}

const LOGIN_COOKIE = 'audit_oidc';
const LOGIN_COOKIE_MAX_AGE_MS = 10 * 60_000;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A tiny HTML page. Redirecting from our own page keeps the SameSite=Strict session cookie on the next request. */
function page(res: Response, status: number, title: string, message: string, next?: string) {
  const go = next ? escapeHtml(next) : null;
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8">${go ? `<meta http-equiv="refresh" content="0;url=${go}">` : ''}` +
        `<title>${escapeHtml(title)}</title><p>${escapeHtml(message)}</p>${go ? `<p><a href="${go}">Continue</a></p>` : ''}`,
    );
}

/** Opens a session for a user who has just proved who they are, and trails the login. */
export async function startSession(db: Db, res: Response, cfg: AuthConfig, user: UserRecord, method: string, details: object) {
  const { token } = await createSession(db.kysely, user.id);
  setSessionCookie(res, token, cfg);
  await recordIdentityEvent(db.kysely, 'login', user, { method, ...details }, { userId: user.id, role: user.role });
}

export function authRoutes(db: Db, auth: AuthDeps): Router {
  const cfg = auth.config;
  const r = Router();

  r.get('/auth/config', (_req, res) => res.json({ devAuth: cfg.devAuth, oidc: !!auth.oidc }));

  if (cfg.devAuth) {
    r.get('/auth/dev-users', (_req, res) => res.json(DEV_USERS));
    r.post('/auth/dev-login', wrap(async (req, res) => {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
      const user = await getUser(db.kysely, userId);
      if (!user || user.issuer !== DEV_ISSUER || !user.active) throw new AppError(401, 'Unknown or inactive demo user', 'UNAUTHENTICATED');
      await startSession(db, res, cfg, user, 'dev', {});
      res.json({ ok: true });
    }));
  }

  const oidc = auth.oidc;
  const oidcCfg = cfg.oidc;
  if (oidc && oidcCfg) {
    r.get('/auth/login', wrap(async (_req, res) => {
      const { url, ...checks } = await oidc.start();
      res.cookie(LOGIN_COOKIE, Buffer.from(JSON.stringify(checks)).toString('base64url'), {
        httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, path: '/auth', maxAge: LOGIN_COOKIE_MAX_AGE_MS,
      });
      res.redirect(url);
    }));

    r.get('/auth/callback', wrap(async (req, res) => {
      const home = `${cfg.publicUrl}/`;
      const raw: unknown = req.cookies?.[LOGIN_COOKIE];
      res.clearCookie(LOGIN_COOKIE, { path: '/auth' });
      let checks: OidcChecks;
      try {
        checks = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
        if (typeof raw !== 'string' || !checks.state || !checks.nonce || !checks.codeVerifier) throw new Error('missing');
      } catch {
        return page(res, 400, 'Sign-in expired', 'Your sign-in attempt expired. Please start again.', home);
      }

      // The token request must use the redirect URI exactly as registered, whatever host the proxy forwarded.
      const callbackUrl = new URL(oidcCfg.redirectUri);
      for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') callbackUrl.searchParams.set(k, v);

      let identity;
      try {
        identity = await oidc.finish(callbackUrl, checks);
      } catch (err) {
        console.warn('OIDC callback rejected:', err instanceof Error ? err.message : err);
        return page(res, 400, 'Sign-in failed', 'The identity provider response could not be verified. Please try again.', home);
      }

      const user = await provisionUser(db.kysely, {
        issuer: identity.issuer, subject: identity.subject, name: identity.name, email: identity.email,
        idpRole: roleFromGroups(identity.groups, oidcCfg.roleMap),
      });
      if (!user.active) return page(res, 403, 'Account deactivated', 'Your account has been deactivated. Contact your administrator.');
      await startSession(db, res, cfg, user, 'oidc', { issuer: identity.issuer, groups: identity.groups });
      page(res, 200, 'Signed in', 'Signed in. Taking you to the audit platform…', home);
    }));
  }

  r.post('/auth/logout', requireUser({ allowPending: true }), wrap(async (req, res) => {
    await revokeSession(db.kysely, String(req.cookies[SESSION_COOKIE]));
    await recordIdentityEvent(db.kysely, 'logout', req.auth!.user, {}, {});
    clearSessionCookie(res, cfg);
    res.status(204).end();
  }));

  r.get('/api/me', requireUser({ allowPending: true }), (req, res) => {
    const { user, csrfToken } = req.auth!;
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrfToken, pendingAccess: !user.role });
  });

  return r;
}
