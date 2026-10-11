import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuthConfig } from './config';
import { actorOf, requireRole } from './http';
import { recordIdentityEvent } from './identity-trail';
import { isRole } from './roles';
import { revokeUserSessions } from './session-repo';
import { getUser, listUsers, setUserActive, setUserRole } from './user-repo';

const PatchUser = z
  .object({
    role: z.string().nullable().refine((r) => r === null || isRole(r), 'role must be auditor, audit_manager, cae, admin, viewer or null'),
    active: z.boolean(),
  })
  .partial();

/** User administration. Admins manage access only; they never see audit content. */
export function adminRoutes(db: Db, cfg: AuthConfig): Router {
  const r = Router();
  r.use('/api/admin', requireRole(['admin']));

  r.get('/api/admin/users', wrap(async (_req, res) => res.json(await listUsers(db.kysely))));

  r.get('/api/admin/settings', (_req, res) =>
    res.json({
      devAuth: cfg.devAuth,
      oidc: cfg.oidc ? { issuer: cfg.oidc.issuer, groupsClaim: cfg.oidc.groupsClaim, roleMap: cfg.oidc.roleMap } : null,
      session: cfg.session,
    }),
  );

  r.patch('/api/admin/users/:id', wrap(async (req, res) => {
    const me = actorOf(req);
    const id = String(req.params.id);
    const patch = PatchUser.parse(req.body);
    const before = await getUser(db.kysely, id);
    if (!before) throw new AppError(404, `User ${id} not found`);
    if (id === me.id && ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false)) {
      throw new AppError(409, 'You cannot remove your own admin access; ask another admin');
    }

    let after = before;
    if (patch.role !== undefined && patch.role !== before.role) {
      const role = patch.role === null ? null : isRole(patch.role) ? patch.role : null;
      after = (await setUserRole(db.kysely, id, role))!;
      await recordIdentityEvent(db.kysely, 'role-change', me, { userId: id, from: before.role, to: after.role }, { roleSource: after.roleSource });
    }
    if (patch.active !== undefined && patch.active !== before.active) {
      after = (await setUserActive(db.kysely, id, patch.active))!;
      const revoked = patch.active ? 0 : await revokeUserSessions(db.kysely, id);
      await recordIdentityEvent(db.kysely, patch.active ? 'reactivate' : 'deactivate', me, { userId: id }, { sessionsRevoked: revoked });
    }
    res.json(after);
  }));

  r.post('/api/admin/users/:id/revoke-sessions', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!(await getUser(db.kysely, id))) throw new AppError(404, `User ${id} not found`);
    const revoked = await revokeUserSessions(db.kysely, id);
    await recordIdentityEvent(db.kysely, 'sessions-revoked', actorOf(req), { userId: id }, { revoked });
    res.json({ revoked });
  }));

  return r;
}
