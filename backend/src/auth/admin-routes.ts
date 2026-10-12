import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db';
import type { Role } from '../engine/types';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { knowledgeDue } from '../knowledge/graph/due';
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

  // Library concepts awaiting expert verification or re-review: ids, titles and dates only.
  r.get('/api/admin/knowledge/due', wrap(async (_req, res) => res.json(await knowledgeDue(db.kysely))));

  r.get('/api/admin/settings', (_req, res) =>
    res.json({
      devAuth: cfg.devAuth,
      oidc: cfg.oidc ? { issuer: cfg.oidc.issuer, groupsClaim: cfg.oidc.groupsClaim, roleMap: cfg.oidc.roleMap } : null,
      session: cfg.session,
    }),
  );

  // Each change and its trail entries commit together, or not at all.
  r.patch('/api/admin/users/:id', wrap(async (req, res) => {
    const me = actorOf(req);
    const id = String(req.params.id);
    const patch = PatchUser.parse(req.body);
    if (patch.role !== undefined && patch.role !== null && !isRole(patch.role)) throw new AppError(400, `Unknown role ${patch.role}`, 'VALIDATION');
    const role = patch.role as Role | null | undefined;
    if (id === me.id && ((role !== undefined && role !== 'admin') || patch.active === false)) {
      throw new AppError(409, 'You cannot remove your own admin access; ask another admin');
    }

    const after = await db.kysely.transaction().execute(async (trx) => {
      const before = await getUser(trx, id);
      if (!before) throw new AppError(404, `User ${id} not found`);
      let current = before;
      if (role !== undefined && role !== before.role) {
        current = (await setUserRole(trx, id, role))!;
        await recordIdentityEvent(trx, 'role-change', me, { userId: id, from: before.role, to: current.role }, { roleSource: current.roleSource });
      }
      if (patch.active !== undefined && patch.active !== before.active) {
        current = (await setUserActive(trx, id, patch.active))!;
        const revoked = patch.active ? 0 : await revokeUserSessions(trx, id);
        await recordIdentityEvent(trx, patch.active ? 'reactivate' : 'deactivate', me, { userId: id }, { sessionsRevoked: revoked });
      }
      return current;
    });
    res.json(after);
  }));

  r.post('/api/admin/users/:id/revoke-sessions', wrap(async (req, res) => {
    const me = actorOf(req);
    const id = String(req.params.id);
    const revoked = await db.kysely.transaction().execute(async (trx) => {
      if (!(await getUser(trx, id))) throw new AppError(404, `User ${id} not found`);
      const n = await revokeUserSessions(trx, id);
      await recordIdentityEvent(trx, 'sessions-revoked', me, { userId: id }, { revoked: n });
      return n;
    });
    res.json({ revoked });
  }));

  return r;
}
