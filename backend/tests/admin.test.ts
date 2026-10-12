import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { getUser } from '../src/auth/user-repo';
import { readTrail } from '../src/db/trail-repo';
import { compilePacks } from '../src/knowledge/graph/compile';
import { loadBundle } from '../src/knowledge/okf/bundle';
import { appWithDevUsers, failTrailWrites, signIn } from './http';
import { demoRoot } from './okf-fixtures';

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

  it('changes nothing for non-admins or anonymous callers', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditorSession = await signIn(app, 'auditor');
    const trailBefore = (await readTrail(svc.db.kysely)).length;
    for (const id of ['auditor', 'reviewer', 'approver', 'viewer']) {
      const u = await signIn(app, id);
      const patch = await u.patch('/api/admin/users/viewer', { role: 'admin', active: false });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('FORBIDDEN');
      const revoke = await u.post('/api/admin/users/auditor/revoke-sessions');
      expect(revoke.status).toBe(403);
      expect(revoke.body.code).toBe('FORBIDDEN');
    }
    expect((await request(app).patch('/api/admin/users/viewer').send({ role: 'admin' })).status).toBe(401);
    expect((await request(app).post('/api/admin/users/auditor/revoke-sessions')).status).toBe(401);
    expect((await request(app).get('/api/admin/users')).status).toBe(401);

    expect(await getUser(svc.db.kysely, 'viewer')).toMatchObject({ role: 'viewer', active: true, roleSource: 'admin' });
    await auditorSession.get('/api/me').expect(200);
    const trail = await readTrail(svc.db.kysely);
    expect(trail.slice(trailBefore).map((b) => b.moduleId)).toEqual(Array(4).fill('identity:login'));
  });

  it('refuses an admin change without the CSRF token, changing and trailing nothing', async () => {
    const { app, svc } = await appWithDevUsers();
    const admin = await signIn(app, 'admin');
    const forged = await admin.agent.patch('/api/admin/users/viewer').send({ role: 'auditor' });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    const revoke = await admin.agent.post('/api/admin/users/viewer/revoke-sessions');
    expect(revoke.status).toBe(403);
    expect(revoke.body.code).toBe('CSRF_FAILED');
    expect(await getUser(svc.db.kysely, 'viewer')).toMatchObject({ role: 'viewer', roleSource: 'admin' });
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login']);
  });

  it('rolls an access change back when it cannot be trailed', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const admin = await signIn(app, 'admin');
    await failTrailWrites(svc.db, ['identity:role-change', 'identity:deactivate', 'identity:sessions-revoked']);

    expect((await admin.patch('/api/admin/users/viewer', { role: 'auditor' })).status).toBe(500);
    expect(await getUser(svc.db.kysely, 'viewer')).toMatchObject({ role: 'viewer' });

    // Role and deactivation in one request: neither may stick.
    expect((await admin.patch('/api/admin/users/auditor', { role: 'viewer', active: false })).status).toBe(500);
    expect(await getUser(svc.db.kysely, 'auditor')).toMatchObject({ role: 'auditor', active: true });
    await auditor.get('/api/me').expect(200);

    expect((await admin.post('/api/admin/users/auditor/revoke-sessions')).status).toBe(500);
    await auditor.get('/api/me').expect(200);
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login', 'identity:login']);
  });
});

describe('knowledge due for re-review', () => {
  it('lists unverified and stale concepts for admins, metadata only [REQ-22]', async () => {
    const { app, svc } = await appWithDevUsers();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const verify = (text: string, staleAfter: string) =>
      text.replace('verified: null', 'verified:\n  by: Dr Rao\n  role: QA SME\n  at: 2026-10-01').replace(/stale_after: .*/, `stale_after: ${staleAfter}`);
    const root = demoRoot((f) => {
      f.set('clauses/ds-1.md', verify(f.get('clauses/ds-1.md')!, '2099-01-01'));
      f.set('clauses/ds-2.md', verify(f.get('clauses/ds-2.md')!, yesterday));
      // Far-future re-review date, so this row stays "unverified only" whatever the wall clock says.
      f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace(/stale_after: .*/, 'stale_after: 2099-06-30'));
    });
    await compilePacks(svc.db, [loadBundle(root, 'demo')]);

    for (const id of ['auditor', 'reviewer', 'approver', 'viewer']) {
      expect((await (await signIn(app, id)).get('/api/admin/knowledge/due')).status).toBe(403);
    }
    const due = (await (await signIn(app, 'admin')).get('/api/admin/knowledge/due').expect(200)).body;
    expect(due).toEqual([
      { nodeId: 'demo/clause/ds-2', conceptId: 'DS-2', type: 'clause', packId: 'demo', packVersion: '0.2.0', title: 'Records',
        sourcePath: 'demo/clauses/ds-2.md', verifiedBy: 'Dr Rao', verifiedAt: '2026-10-01', staleAfter: yesterday, reasons: ['stale'] },
      { nodeId: 'demo/control/dm-01', conceptId: 'DM-01', type: 'control', packId: 'demo', packVersion: '0.2.0', title: 'Records are reviewed',
        sourcePath: 'demo/controls/dm-01.md', verifiedBy: null, verifiedAt: null, staleAfter: '2099-06-30', reasons: ['unverified'] },
    ]);
    // Admins manage access, not audit content: no bodies, descriptions or attributes.
    expect(Object.keys(due[0]).sort()).toEqual(['conceptId', 'nodeId', 'packId', 'packVersion', 'reasons', 'sourcePath', 'staleAfter', 'title', 'type', 'verifiedAt', 'verifiedBy']);
  });
});
