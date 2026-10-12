import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { OidcConfig } from '../src/auth/config';
import { createOidcClient, roleFromGroups, type OidcClient } from '../src/auth/oidc';
import { listUsers, setUserActive } from '../src/auth/user-repo';
import { readTrail } from '../src/db/trail-repo';
import type { AuditService } from '../src/service';
import { newService } from './helpers';
import { devAuthConfig, failTrailWrites } from './http';
import { startMockOidc, type MockUser } from './mock-oidc';

describe('OIDC sign-in', () => {
  let mock: Awaited<ReturnType<typeof startMockOidc>>;
  let oidcCfg: OidcConfig;
  let oidc: OidcClient;

  beforeAll(async () => {
    mock = await startMockOidc();
    oidcCfg = {
      issuer: mock.issuer, clientId: 'audit-platform', clientSecret: 'test-secret', redirectUri: 'http://localhost:5174/auth/callback',
      groupsClaim: 'groups', scopes: 'openid profile email groups', roleMap: { 'audit-cae': 'cae', 'audit-auditors': 'auditor', 'audit-managers': 'audit_manager' }, allowInsecure: true,
    };
    oidc = await createOidcClient(oidcCfg);
  });
  afterAll(() => mock.close());

  async function setup(): Promise<{ svc: AuditService; app: ReturnType<typeof createApp> }> {
    const svc = await newService();
    return { svc, app: createApp(svc, { config: devAuthConfig({ devAuth: false, oidc: oidcCfg }), oidc }) };
  }

  /** Browser round trip: our /auth/login → IdP /authorize → our /auth/callback. */
  async function login(app: ReturnType<typeof createApp>, user: MockUser) {
    mock.setUser(user);
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const authorize = await fetch(start.headers.location, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    const res = await agent.get(callback.pathname + callback.search);
    return { agent, res, callback };
  }

  it('signs a user in through the identity provider and maps their group to a role [REQ-16]', async () => {
    const { app, svc } = await setup();
    expect((await request(app).get('/auth/config')).body).toEqual({ devAuth: false, oidc: true });
    const { agent, res } = await login(app, { sub: 'p-1', name: 'Priya Prakash', email: 'priya@example.com', groups: ['audit-cae', 'staff'] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('http://localhost:5174/');
    const me = await agent.get('/api/me').expect(200);
    expect(me.body).toMatchObject({ user: { name: 'Priya Prakash', email: 'priya@example.com', role: 'cae' }, pendingAccess: false });
    const login1 = (await readTrail(svc.db.kysely)).find((b) => b.moduleId === 'identity:login')!;
    expect(login1.inputs).toMatchObject({ method: 'oidc', issuer: mock.issuer, groups: ['audit-cae', 'staff'] });
  });

  it('follows group changes at the next sign-in, trails them, and leaves unmapped users pending', async () => {
    const { app, svc } = await setup();
    await login(app, { sub: 'a-1', name: 'Anil', groups: ['audit-auditors'] });
    await login(app, { sub: 'a-1', name: 'Anil', groups: ['audit-auditors'] }); // unchanged: no role-change event
    const { agent } = await login(app, { sub: 'a-1', name: 'Anil', groups: ['audit-managers'] });
    expect((await agent.get('/api/me')).body.user.role).toBe('audit_manager');
    const [anil] = await listUsers(svc.db.kysely);
    const changes = (await readTrail(svc.db.kysely)).filter((b) => b.moduleId === 'identity:role-change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor: 'idp', engagementId: null, inputs: { userId: anil.id, from: 'auditor', to: 'audit_manager', source: 'idp' },
    });
    expect(changes[0].executionLog[0].detail).toContain(mock.issuer);

    const pending = await login(app, { sub: 'n-1', name: 'New Joiner', groups: ['staff'] });
    expect((await pending.agent.get('/api/me')).body).toMatchObject({ pendingAccess: true, user: { role: null } });
    const blocked = await pending.agent.get('/api/engagements');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PENDING_ACCESS');
  });

  it('refuses a callback without the login cookie or with a tampered state, creating nothing', async () => {
    const { app, svc } = await setup();
    const { callback } = await login(app, { sub: 'x-1', name: 'X', groups: ['audit-auditors'] });
    const noCookie = await request(app).get(callback.pathname + callback.search);
    expect(noCookie.status).toBe(400);
    expect(noCookie.text).toMatch(/expired/i);

    mock.setUser({ sub: 't-1', name: 'Tampered', groups: ['audit-cae'] });
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const authorize = await fetch(start.headers.location, { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    cb.searchParams.set('state', 'forged');
    const res = await agent.get(cb.pathname + cb.search);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/could not be verified/);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await listUsers(svc.db.kysely)).map((u) => u.subject)).toEqual(['x-1']);

    const denied = await agent.get('/auth/callback?error=access_denied&state=whatever');
    expect(denied.status).toBe(400);
  });

  it('turns away a deactivated user at the door', async () => {
    const { app, svc } = await setup();
    await login(app, { sub: 'd-1', name: 'Dee', groups: ['audit-auditors'] });
    const [dee] = await listUsers(svc.db.kysely);
    await setUserActive(svc.db.kysely, dee.id, false);
    const { agent, res } = await login(app, { sub: 'd-1', name: 'Dee Renamed', groups: ['audit-cae'] });
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/deactivated/);
    expect(res.headers['set-cookie']?.join(';') ?? '').not.toMatch(/audit_session=[^;]/);
    expect((await agent.get('/api/me')).status).toBe(401);
    const [after] = await listUsers(svc.db.kysely);
    expect(after).toEqual({ ...dee, active: false }); // name, role and last login untouched
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login']);
  });

  it('asks the identity provider for the configured scopes', async () => {
    const { app } = await setup();
    const start = await request(app).get('/auth/login').expect(302);
    expect(new URL(start.headers.location).searchParams.get('scope')).toBe('openid profile email groups');
  });

  it('rolls back an IdP role change and the sign-in when they cannot be trailed', async () => {
    const { app, svc } = await setup();
    await login(app, { sub: 'r-1', name: 'Rhea', groups: ['audit-auditors'] });
    const [before] = await listUsers(svc.db.kysely);
    await failTrailWrites(svc.db, ['identity:role-change']);
    const { agent, res } = await login(app, { sub: 'r-1', name: 'Rhea', groups: ['audit-cae'] });
    expect(res.status).toBe(500);
    expect(res.headers['set-cookie']?.join(';') ?? '').not.toMatch(/audit_session=[^;]/);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await listUsers(svc.db.kysely))[0]).toEqual(before);
    expect(await svc.db.kysely.selectFrom('sessions').select('id').execute()).toHaveLength(1);
  });

  it('picks the most senior mapped role when groups map to several', () => {
    const map = { a: 'viewer', b: 'auditor', c: 'cae', d: 'admin' } as const;
    expect(roleFromGroups(['a', 'b'], map)).toBe('auditor');
    expect(roleFromGroups(['d', 'c'], map)).toBe('cae');
    expect(roleFromGroups(['d', 'a'], map)).toBe('admin');
    expect(roleFromGroups(['zzz'], map)).toBeNull();
  });
});
