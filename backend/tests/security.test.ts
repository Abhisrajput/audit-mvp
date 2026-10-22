import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEFAULT_RATE_LIMITS } from '../src/http/security';
import { resultPage } from '../src/signing/pages';
import { appWithDevUsers, devAuthConfig, signIn } from './http';

const LOW = { ...DEFAULT_RATE_LIMITS, authPerMinute: 2, signingPerMinute: 2 };

describe('HTTP security', () => {
  it('sends strict security headers on API responses and no framework banner', async () => {
    const { app } = await appWithDevUsers();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets a sign-in or signing page run only its own script, through a fresh nonce', async () => {
    const app = express();
    app.get('/done', (_req, res) => resultPage(res, { ok: true }));
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get('/done').expect(200);
      const header = res.headers['content-security-policy'] as string;
      const fromHeader = /script-src 'nonce-([^']+)'/.exec(header)?.[1];
      const fromBody = /<script nonce="([^"]+)">/.exec(res.text)?.[1];
      expect(fromHeader).toBeDefined();
      expect(fromBody).toBe(fromHeader);
      expect(header).toContain("default-src 'none'");
      expect(header).toContain("frame-ancestors 'none'");
      nonces.push(fromHeader!);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('counts each client behind a trusted proxy separately, and ignores forged forwarding headers otherwise', async () => {
    const { svc } = await appWithDevUsers();
    const behindNginx = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { trustProxy: 1, rateLimits: LOW });
    const a = () => request(behindNginx).get('/auth/config').set('X-Forwarded-For', '203.0.113.1');
    await a().expect(200);
    await a().expect(200);
    const limited = await a().expect(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', requestId: limited.headers['x-request-id'] });
    expect(limited.headers['ratelimit']).toBeDefined();
    await request(behindNginx).get('/auth/config').set('X-Forwarded-For', '203.0.113.2').expect(200);

    const direct = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { rateLimits: LOW });
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.2').expect(200);
    // A new forged address does not buy a fresh allowance: without a trusted proxy the socket address is the client.
    await request(direct).get('/auth/config').set('X-Forwarded-For', '203.0.113.3').expect(429);
  });

  it('limits signing requests per client [REQ-18]', async () => {
    const { svc } = await appWithDevUsers();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { rateLimits: { ...DEFAULT_RATE_LIMITS, authPerMinute: 100, signingPerMinute: 2 } });
    const reviewer = await signIn(app, 'reviewer');
    const start = () => reviewer.post('/api/engagements/ENG-NONE/findings/F-NONE/sign-intents', { action: 'review' });
    expect((await start()).status).toBe(404);
    expect((await start()).status).toBe(404);
    const limited = await start();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});
