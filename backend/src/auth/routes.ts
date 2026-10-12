import { Router, type Request, type Response } from 'express';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db';
import type { DB } from '../db/schema';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { logger } from '../observability/log';
import type { AuthConfig } from './config';
import { DEV_ISSUER, DEV_USERS } from './dev-users';
import { clearSessionCookie, requireUser, SESSION_COOKIE, setSessionCookie } from './http';
import { recordIdentityEvent } from './identity-trail';
import { page } from './page';
import { createSession, revokeSession } from './session-repo';
import type { OidcChecks, OidcClient } from './oidc';
import { roleFromGroups } from './oidc';
import { getUser, getUserByIdentity, provisionUser, type UserRecord } from './user-repo';

export interface AuthDeps {
  config: AuthConfig;
  /** null when no identity provider is configured (DEV_AUTH only). */
  oidc: OidcClient | null;
}

const LOGIN_COOKIE = 'audit_oidc';
const LOGIN_COOKIE_MAX_AGE_MS = 10 * 60_000;

/** Creates the session and trails the login inside the caller's transaction; returns the cookie token. */
async function openSession(trx: Transaction<DB>, user: UserRecord, method: string, details: object): Promise<string> {
  const { token } = await createSession(trx, user.id);
  await recordIdentityEvent(trx, 'login', user, { method, ...details }, { userId: user.id, role: user.role });
  return token;
}

/**
 * Opens a session for a user who has just proved who they are, and trails the login.
 * The session and its trail entry commit together; the cookie is set only after commit.
 */
export async function startSession(db: Db, res: Response, cfg: AuthConfig, user: UserRecord, method: string, details: object) {
  const token = await db.kysely.transaction().execute((trx) => openSession(trx, user, method, details));
  setSessionCookie(res, token, cfg);
}

export interface AuthHooks {
  /** Gets the IdP callback first; returns true when it handled the response (e.g. a signing re-authentication). */
  idpCallback?: (req: Request, res: Response) => Promise<boolean>;
}

export function authRoutes(db: Db, auth: AuthDeps, hooks: AuthHooks = {}): Router {
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
      if (hooks.idpCallback && (await hooks.idpCallback(req, res))) return;
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
        logger.warn({ err }, 'OIDC callback rejected');
        return page(res, 400, 'Sign-in failed', 'The identity provider response could not be verified. Please try again.', home);
      }

      // Provisioning, any IdP-driven role change, the session and the login trail commit together.
      const token = await db.kysely.transaction().execute(async (trx) => {
        const existing = await getUserByIdentity(trx, identity.issuer, identity.subject, true);
        // A deactivated user is turned away before anything about them is updated.
        if (existing && !existing.active) return null;
        const user = await provisionUser(trx, {
          issuer: identity.issuer, subject: identity.subject, name: identity.name, email: identity.email,
          idpRole: roleFromGroups(identity.groups, oidcCfg.roleMap),
        });
        if (existing && existing.role !== user.role) {
          await recordIdentityEvent(
            trx, 'role-change', { id: 'idp', name: identity.issuer, role: null },
            { userId: user.id, from: existing.role, to: user.role, source: 'idp' }, { roleSource: user.roleSource },
          );
        }
        return openSession(trx, user, 'oidc', { issuer: identity.issuer, groups: identity.groups });
      });
      if (!token) return page(res, 403, 'Account deactivated', 'Your account has been deactivated. Contact your administrator.');
      setSessionCookie(res, token, cfg);
      page(res, 200, 'Signed in', 'Signed in. Taking you to the audit platform…', home);
    }));
  }

  r.post('/auth/logout', requireUser({ allowPending: true }), wrap(async (req, res) => {
    const token = String(req.cookies[SESSION_COOKIE]);
    await db.kysely.transaction().execute(async (trx) => {
      await revokeSession(trx, token);
      await recordIdentityEvent(trx, 'logout', req.auth!.user, {}, {});
    });
    clearSessionCookie(res, cfg);
    res.status(204).end();
  }));

  r.get('/api/me', requireUser({ allowPending: true }), (req, res) => {
    const { user, csrfToken } = req.auth!;
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrfToken, pendingAccess: !user.role });
  });

  return r;
}
