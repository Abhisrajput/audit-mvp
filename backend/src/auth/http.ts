import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import type { Role, User } from '../engine/types';
import { AppError } from '../errors';
import type { AuthConfig } from './config';
import { resolveSession, type ActiveSession, type SessionPolicy } from './session-repo';

declare module 'express-serve-static-core' {
  interface Request {
    /** The signed-in session, set by sessionMiddleware when the cookie resolves. */
    auth?: ActiveSession;
  }
}

export const SESSION_COOKIE = 'audit_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionMiddleware(db: Kysely<DB>, policy: SessionPolicy): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) return next();
    resolveSession(db, token, policy).then((session) => {
      if (session) req.auth = session;
      next();
    }, next);
  };
}

function sameToken(sent: string, expected: string) {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Requires a signed-in user. State-changing requests must echo the session's
 * CSRF token in x-csrf-token. Users without a role are "pending access" and
 * may only reach routes that opt in with allowPending.
 */
export function requireUser(opts: { allowPending?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const session = req.auth;
    if (!session) return next(new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED'));
    if (!SAFE_METHODS.has(req.method) && !sameToken(req.header('x-csrf-token') ?? '', session.csrfToken)) {
      return next(new AppError(403, 'Missing or invalid CSRF token; reload the page and try again', 'CSRF_FAILED'));
    }
    if (!session.user.role && !opts.allowPending) {
      return next(new AppError(403, 'Your account is waiting for an administrator to assign a role', 'PENDING_ACCESS'));
    }
    next();
  };
}

export function requireRole(roles: readonly Role[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.auth?.user.role;
    if (!role || !roles.includes(role)) return next(new AppError(403, `${role ?? 'This account'} may not access this`, 'FORBIDDEN'));
    next();
  };
}

/** The signed-in user as the service sees them. */
export function actorOf(req: Request): User {
  const user = req.auth?.user;
  if (!user?.role) throw new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED');
  return { id: user.id, name: user.name, role: user.role };
}

export function setSessionCookie(res: Response, token: string, cfg: AuthConfig) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/', maxAge: cfg.session.maxHours * 3_600_000,
  });
}

export function clearSessionCookie(res: Response, cfg: AuthConfig) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/' });
}
