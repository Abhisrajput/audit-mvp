import { describe, expect, it } from 'vitest';
import { readTrail } from '../src/db/trail-repo';
import { appWithDevUsers, signIn } from './http';

describe('administration', () => {
  it('is for admins only', async () => {
    const { app } = await appWithDevUsers();
    for (const id of ['auditor', 'reviewer', 'approver', 'viewer']) {
      const u = await signIn(app, id);
      expect((await u.get('/api/admin/users')).status).toBe(403);
    }
    const admin = await signIn(app, 'admin');
    const users = (await admin.get('/api/admin/users').expect(200)).body;
    expect(users.map((u: any) => [u.id, u.role, u.active])).toContainEqual(['auditor', 'auditor', true]);
    expect((await admin.get('/api/admin/settings').expect(200)).body).toEqual({
      devAuth: true, oidc: null, session: { idleMinutes: 30, maxHours: 12 },
    });
  });

  it('changes a role with effect on the very next request, and trails it', async () => {
    const { app, svc } = await appWithDevUsers();
    const viewer = await signIn(app, 'viewer');
    expect((await viewer.post('/api/engagements', { name: 'n', entity: 'e', site: 's', periodFrom: 'a', periodTo: 'b', auditType: 't', scopeStatement: 'hedging', packIds: ['common'] })).status).toBe(403);

    const admin = await signIn(app, 'admin');
    const updated = await admin.patch('/api/admin/users/viewer', { role: 'auditor' }).expect(200);
    expect(updated.body).toMatchObject({ id: 'viewer', role: 'auditor', roleSource: 'admin' });

    await viewer.post('/api/engagements', { name: 'n', entity: 'e', site: 's', periodFrom: 'a', periodTo: 'b', auditType: 't', scopeStatement: 'hedging', packIds: ['common'] }).expect(201);
    const change = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:role-change')!;
    expect(change).toMatchObject({ actor: 'admin', engagementId: null, inputs: { userId: 'viewer', from: 'viewer', to: 'auditor' } });

    await admin.patch('/api/admin/users/viewer', { role: null }).expect(200);
    const pending = await viewer.get('/api/engagements');
    expect(pending.body.code).toBe('PENDING_ACCESS');
    expect((await admin.patch('/api/admin/users/viewer', { role: 'superuser' })).status).toBe(400);
    expect((await admin.patch('/api/admin/users/nobody', { role: 'auditor' })).status).toBe(404);
  });

  it('deactivating a user ends their sessions at once; reactivating lets them sign in again', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const admin = await signIn(app, 'admin');
    await admin.patch('/api/admin/users/auditor', { active: false }).expect(200);
    expect((await auditor.get('/api/me')).status).toBe(401);
    expect((await auditor.agent.post('/auth/dev-login').send({ userId: 'auditor' })).status).toBe(401);
    await admin.patch('/api/admin/users/auditor', { active: true }).expect(200);
    await signIn(app, 'auditor');
    const events = (await readTrail(svc.db.kysely)).map((b) => b.moduleId);
    expect(events).toEqual(expect.arrayContaining(['identity:deactivate', 'identity:reactivate']));
  });

  it('signs a user out everywhere on request', async () => {
    const { app } = await appWithDevUsers();
    const a1 = await signIn(app, 'auditor');
    const a2 = await signIn(app, 'auditor');
    const admin = await signIn(app, 'admin');
    expect((await admin.post('/api/admin/users/auditor/revoke-sessions').expect(200)).body).toEqual({ revoked: 2 });
    expect((await a1.get('/api/me')).status).toBe(401);
    expect((await a2.get('/api/me')).status).toBe(401);
  });

  it('will not let an admin lock themselves out', async () => {
    const { app } = await appWithDevUsers();
    const admin = await signIn(app, 'admin');
    expect((await admin.patch('/api/admin/users/admin', { role: 'viewer' })).status).toBe(409);
    expect((await admin.patch('/api/admin/users/admin', { active: false })).status).toBe(409);
    expect((await admin.get('/api/admin/users')).status).toBe(200);
  });
});
