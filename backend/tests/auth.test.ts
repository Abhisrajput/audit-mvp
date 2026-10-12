import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../src/auth/config';
import { readTrail } from '../src/db/trail-repo';
import { createApp } from '../src/app';
import { appWithDevUsers, devAuthConfig, failTrailWrites, restoreTrailWrites, signIn } from './http';

const NEW_ENGAGEMENT = {
  name: 'n', entity: 'e', site: 's', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 't', scopeStatement: 'hedging limits', packIds: ['common'],
};

describe('sign-in and sessions', () => {
  it('requires a session for audit content but not for health or sign-in options', async () => {
    const { app } = await appWithDevUsers();
    await request(app).get('/api/health').expect(200);
    expect((await request(app).get('/auth/config').expect(200)).body).toEqual({ devAuth: true, oidc: false });
    const res = await request(app).get('/api/engagements').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('signs a demo user in, shows who they are, and trails the login', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const me = await auditor.get('/api/me').expect(200);
    expect(me.body).toMatchObject({ user: { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, pendingAccess: false });
    expect(me.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const trail = await readTrail(svc.db.kysely);
    expect(trail.map((b) => [b.moduleId, b.actor, b.engagementId])).toEqual([['identity:login', 'auditor', null]]);
    await request(app).post('/auth/dev-login').send({ userId: 'nobody' }).expect(401);
  });

  it('rejects a state-changing request without the CSRF token, and changes nothing', async () => {
    const { app } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    const forged = await auditor.agent.post('/api/engagements').send(NEW_ENGAGEMENT);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    expect((await auditor.agent.post('/api/engagements').set('x-csrf-token', 'wrong').send(NEW_ENGAGEMENT)).status).toBe(403);
    expect((await auditor.get('/api/engagements')).body).toEqual([]);
    await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
  });

  it('makes the cookie useless after logout', async () => {
    const { app, svc } = await appWithDevUsers();
    const login = await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(200);
    const cookie = login.headers['set-cookie'] as unknown as string[];
    expect(cookie.join(';')).toMatch(/audit_session=.*HttpOnly.*SameSite=Strict/i);
    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app).post('/auth/logout').set('Cookie', cookie).expect(403); // no CSRF token
    await request(app).post('/auth/logout').set('Cookie', cookie).set('x-csrf-token', me.body.csrfToken).expect(204);
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login', 'identity:logout']);
  });

  it('opens no session when the login cannot be trailed', async () => {
    const { app, svc } = await appWithDevUsers();
    await failTrailWrites(svc.db, ['identity:login']);
    const res = await request(app).post('/auth/dev-login').send({ userId: 'auditor' });
    expect(res.status).toBe(500);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await svc.db.kysely.selectFrom('sessions').selectAll().execute()).toEqual([]);
    expect(await readTrail(svc.db.kysely)).toEqual([]);
  });

  it('keeps the session alive when the logout cannot be trailed', async () => {
    const { app, svc } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    await failTrailWrites(svc.db, ['identity:logout']);
    const res = await auditor.post('/auth/logout');
    expect(res.status).toBe(500);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/audit_session=;/);
    await auditor.get('/api/me').expect(200);
    await restoreTrailWrites(svc.db);
    await auditor.post('/auth/logout').expect(204);
    expect((await readTrail(svc.db.kysely)).map((b) => b.moduleId)).toEqual(['identity:login', 'identity:logout']);
  });

  it('ends demo sessions once DEV_AUTH is turned off', async () => {
    const { app, svc } = await appWithDevUsers();
    const login = await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(200);
    const cookie = login.headers['set-cookie'] as unknown as string[];
    await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    const hardened = createApp(svc, { config: devAuthConfig({ devAuth: false }), oidc: null });
    const res = await request(hardened).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect((await request(hardened).get('/api/engagements').set('Cookie', cookie)).status).toBe(401);
  });

  it('keeps admins out of audit content and viewers read-only [REQ-15]', async () => {
    const { app } = await appWithDevUsers();
    const auditor = await signIn(app, 'auditor');
    await auditor.post('/api/engagements', NEW_ENGAGEMENT).expect(201);

    const admin = await signIn(app, 'admin');
    const denied = await admin.get('/api/engagements');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    await admin.get('/api/packs').expect(403);

    const viewer = await signIn(app, 'viewer');
    expect((await viewer.get('/api/engagements').expect(200)).body).toHaveLength(1);
    expect((await viewer.post('/api/engagements', NEW_ENGAGEMENT)).status).toBe(403);
    expect((await viewer.post('/api/eval/run')).status).toBe(403);
  });
});

describe('DEV_AUTH safety', () => {
  it('offers no demo sign-in when DEV_AUTH is off', async () => {
    const { app } = await appWithDevUsers(devAuthConfig({ devAuth: false }));
    await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(404);
    await request(app).get('/auth/dev-users').expect(404);
  });

  it('refuses to start with DEV_AUTH in production, and needs OIDC otherwise [REQ-16]', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/d' };
    expect(() => loadAuthConfig({ ...base, NODE_ENV: 'production', DEV_AUTH: 'true' })).toThrow(/DEV_AUTH must not be true in production/);
    expect(() => loadAuthConfig({ ...base, DEV_AUTH: 'false' })).toThrow(/OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI are required/);
    expect(() =>
      loadAuthConfig({ ...base, NODE_ENV: 'production', OIDC_ISSUER: 'http://idp.example.com', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback' }),
    ).toThrow(/OIDC_ISSUER must use https in production/);
    expect(() => loadAuthConfig({ ...base, DEV_AUTH: 'true', OIDC_ROLE_MAP: '{"g":"superuser"}' })).toThrow(/OIDC_ROLE_MAP/);

    const prod = loadAuthConfig({
      ...base, NODE_ENV: 'production', OIDC_ISSUER: 'https://login.example.com/tenant/v2.0', OIDC_CLIENT_ID: 'audit', OIDC_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback', OIDC_ROLE_MAP: '{"Audit-CAE":"cae"}', PUBLIC_URL: 'https://audit.example.com',
    });
    expect(prod).toMatchObject({
      devAuth: false, secureCookies: true, publicUrl: 'https://audit.example.com', session: { idleMinutes: 30, maxHours: 12 },
      oidc: { issuer: 'https://login.example.com/tenant/v2.0', clientId: 'audit', clientSecret: 's', groupsClaim: 'groups', scopes: 'openid profile email', roleMap: { 'Audit-CAE': 'cae' }, allowInsecure: false },
    });
    expect(loadAuthConfig({ ...base, DEV_AUTH: 'true', OIDC_ISSUER: '', OIDC_CLIENT_ID: '' })).toMatchObject({ devAuth: true, secureCookies: false, oidc: null });
  });

  it('refuses production settings that would silently break sign-in', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/d' };
    const prodOidc = { ...base, NODE_ENV: 'production', OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'c' };
    expect(() =>
      loadAuthConfig({ ...prodOidc, PUBLIC_URL: 'http://audit.example.com', OIDC_REDIRECT_URI: 'http://audit.example.com/auth/callback' }),
    ).toThrow(/PUBLIC_URL must use https in production[\s\S]*OIDC_REDIRECT_URI must use https in production/);
    expect(() =>
      loadAuthConfig({ ...prodOidc, PUBLIC_URL: 'https://audit.example.com', OIDC_REDIRECT_URI: 'https://api.example.com/auth/callback' }),
    ).toThrow(/OIDC_REDIRECT_URI must be on the same origin as PUBLIC_URL.*SameSite/);
    // The origin rule applies outside production too.
    expect(() =>
      loadAuthConfig({ ...base, DEV_AUTH: 'true', OIDC_ISSUER: 'http://localhost:8081/realms/audit', OIDC_CLIENT_ID: 'c', PUBLIC_URL: 'http://localhost:5174', OIDC_REDIRECT_URI: 'http://localhost:3002/auth/callback' }),
    ).toThrow(/same origin as PUBLIC_URL/);
    expect(
      loadAuthConfig({ ...base, OIDC_ISSUER: 'http://localhost:8081/realms/audit', OIDC_CLIENT_ID: 'c', PUBLIC_URL: 'http://localhost:5174/', OIDC_REDIRECT_URI: 'http://localhost:5174/auth/callback' }).oidc,
    ).toMatchObject({ redirectUri: 'http://localhost:5174/auth/callback', scopes: 'openid profile email' });
    expect(
      loadAuthConfig({ ...base, OIDC_ISSUER: 'http://localhost:8081/realms/audit', OIDC_CLIENT_ID: 'c', OIDC_REDIRECT_URI: 'http://localhost:5174/auth/callback', OIDC_SCOPES: 'openid profile email groups' }).oidc?.scopes,
    ).toBe('openid profile email groups');
  });
});
