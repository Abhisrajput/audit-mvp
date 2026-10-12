import express from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { errorHandler, pgErrorResponse } from '../src/http/errors';
import { requestContext } from '../src/observability/context';
import { accessLog, captureLogs, logger } from '../src/observability/log';
import { auditor, NEW_ENGAGEMENT } from './helpers';
import { appWithDevUsers, devAuthConfig, signIn } from './http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request ids and error responses', () => {
  it('answers unexpected errors with only a code and the request id, and logs the detail under that id', async () => {
    const { svc, app } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    await sql`ALTER TABLE engagements RENAME TO engagements_gone`.execute(svc.db.kysely);
    const logs = captureLogs('info');
    const res = await user.get('/api/engagements').expect(500);
    logs.restore();
    expect(res.body).toEqual({ code: 'INTERNAL', requestId: res.headers['x-request-id'] });
    expect(res.headers['x-request-id']).toMatch(UUID);
    const line = logs.text().split('\n').find((l) => l.includes('"unexpected error"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: 50, requestId: res.headers['x-request-id'] });
    expect(line).toContain('engagements');
  });

  it('maps database constraint and trigger errors to 4xx without echoing Postgres details', async () => {
    const pgError = (code: string, message = `duplicate key value violates "x" Key (id)=(SECRET-${code})`) =>
      Object.assign(new Error(message), { code, severity: 'ERROR', detail: `Key (id)=(SECRET-${code})` });
    expect(pgErrorResponse(pgError('23505'))).toEqual({ status: 409, code: 'CONFLICT', message: 'This record already exists' });
    expect(pgErrorResponse(pgError('23503'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This refers to a record that does not exist' });
    expect(pgErrorResponse(pgError('23514'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This value is not allowed' });
    expect(pgErrorResponse(pgError('22P05'))).toEqual({ status: 400, code: 'VALIDATION', message: 'This text contains characters that cannot be stored' });
    // Only the append-only and locked-finding triggers mean "immutable"; a missing grant is a server fault.
    const immutable = { status: 403, code: 'RECORD_IMMUTABLE', message: 'This record cannot be changed' };
    expect(pgErrorResponse(pgError('42501', 'trail is append-only: UPDATE rejected'))).toEqual(immutable);
    expect(pgErrorResponse(pgError('42501', 'Approved finding F-1 is locked: UPDATE rejected'))).toEqual(immutable);
    expect(pgErrorResponse(pgError('42501', 'permission denied for table trail'))).toBeNull();
    expect(pgErrorResponse(pgError('42P01'))).toBeNull();
    expect(pgErrorResponse(new Error('plain'))).toBeNull();

    const app = express();
    app.use(requestContext({ trustProxy: 0 }));
    app.use(express.json());
    app.get('/dup', () => { throw pgError('23505'); });
    app.get('/grant', () => { throw pgError('42501', 'permission denied for table trail'); });
    app.post('/json', (_req, res) => { res.json({}); });
    app.use(errorHandler());
    const logs = captureLogs('warn');
    const res = await request(app).get('/dup').expect(409);
    const grant = await request(app).get('/grant').expect(500);
    const badJson = await request(app).post('/json').set('Content-Type', 'application/json').send('{"broken": ').expect(400);
    logs.restore();
    expect(res.body).toEqual({ error: 'This record already exists', code: 'CONFLICT', requestId: res.headers['x-request-id'] });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(logs.text()).toContain('SECRET-23505');
    expect(grant.body).toEqual({ code: 'INTERNAL', requestId: grant.headers['x-request-id'] });
    const grantLine = logs.text().split('\n').find((l) => l.includes('permission denied'));
    expect(JSON.parse(grantLine!)).toMatchObject({ level: 50, msg: 'unexpected error', requestId: grant.headers['x-request-id'] });
    expect(badJson.body).toEqual({ error: 'The request body is not valid JSON', code: 'VALIDATION', requestId: badJson.headers['x-request-id'] });
  });

  it('writes one access-log line per request with a single request id', async () => {
    const app = express();
    app.use(requestContext({ trustProxy: 0 }));
    app.use(accessLog());
    app.get('/things/:id', (_req, res) => { res.json({}); });
    const logs = captureLogs('info');
    const res = await request(app).get('/things/42').expect(200);
    logs.restore();
    const lines = logs.text().split('\n').filter((l) => l.includes('"msg":"request"'));
    expect(lines).toHaveLength(1);
    // JSON.parse would collapse a duplicated key, so count on the raw text.
    expect(lines[0].match(/"requestId"/g)).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 30, method: 'GET', route: '/things/:id', status: 200, user: null, requestId: res.headers['x-request-id'] });
  });

  it('stamps the request id into the trail bundles a request writes', async () => {
    const { svc, app } = await appWithDevUsers();
    const user = await signIn(app, 'auditor');
    const res = await user.post('/api/engagements', NEW_ENGAGEMENT).expect(201);
    await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const trail = await readTrail(svc.db.kysely);
    const created = trail.filter((b) => b.moduleId === 'human:create-engagement');
    expect(created.map((b) => b.requestId)).toEqual([res.headers['x-request-id'], undefined]);
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('uses a forwarded X-Request-Id only from a trusted proxy', async () => {
    const { svc } = await appWithDevUsers();
    const direct = createApp(svc, { config: devAuthConfig(), oidc: null });
    const proxied = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { trustProxy: 1 });
    expect((await request(direct).get('/api/health').set('X-Request-Id', 'chosen-by-client-1')).headers['x-request-id']).toMatch(UUID);
    expect((await request(proxied).get('/api/health').set('X-Request-Id', 'nginx-0123456789abcdef')).headers['x-request-id']).toBe('nginx-0123456789abcdef');
    expect((await request(proxied).get('/api/health').set('X-Request-Id', 'bad id with spaces')).headers['x-request-id']).toMatch(UUID);
  });

  it('never logs session tokens, CSRF tokens or secrets, even at trace', async () => {
    const { svc, app } = await appWithDevUsers();
    const logs = captureLogs('trace');
    const login = await request(app).post('/auth/dev-login').send({ userId: 'auditor' }).expect(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const token = cookie.split('=')[1];
    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    const csrf = me.body.csrfToken as string;
    await request(app).post('/api/engagements').set('Cookie', cookie).set('x-csrf-token', csrf).send(NEW_ENGAGEMENT).expect(201);
    await sql`ALTER TABLE engagements RENAME TO engagements_gone`.execute(svc.db.kysely);
    await request(app).get('/api/engagements').set('Cookie', cookie).expect(500);
    logger.info({ oidc: { clientSecret: 'oidc-client-secret-value' }, headers: { authorization: 'Bearer abc' } }, 'config snapshot');
    logs.restore();
    const text = logs.text();
    expect(text).toContain('"route":"/api/engagements"');
    expect(text).toContain('[redacted]');
    for (const secret of [token, csrf, 'oidc-client-secret-value']) expect(text).not.toContain(secret);
  });
});
