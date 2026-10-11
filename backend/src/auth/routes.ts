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
import { getUser, type UserRecord } from './user-repo';

export interface AuthDeps {
  config: AuthConfig;
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

  r.get('/auth/config', (_req, res) => res.json({ devAuth: cfg.devAuth, oidc: false }));

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
