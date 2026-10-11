import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { OidcConfig } from '../src/auth/config';
import { createOidcClient, type OidcClient } from '../src/auth/oidc';
import { listSignatures } from '../src/db/signature-repo';
import { readTrail } from '../src/db/trail-repo';
import type { AuditService } from '../src/service';
import { newService } from './helpers';
import { devAuthConfig, signIn } from './http';
import { startMockOidc, type MockUser } from './mock-oidc';

const PRIYA: MockUser = { sub: 'priya-1', name: 'Priya Prakash', email: 'priya@example.test', groups: ['audit-cae'] };

describe('signing with identity-provider re-authentication', () => {
  let mock: Awaited<ReturnType<typeof startMockOidc>>;
  let oidcCfg: OidcConfig;
  let oidc: OidcClient;

  beforeAll(async () => {
    mock = await startMockOidc();
    oidcCfg = {
      issuer: mock.issuer, clientId: 'audit-platform', clientSecret: 'test-secret', redirectUri: 'http://localhost:5174/auth/callback',
      groupsClaim: 'groups', roleMap: { 'audit-cae': 'cae' }, allowInsecure: true, scopes: 'openid profile email',
    };
    oidc = await createOidcClient(oidcCfg);
  });
  afterAll(() => mock.close());
  beforeEach(() => mock.setAuthTimeOffset(0));

  /**
   * Demo users prepare and review a finding; the CAE signs in through the IdP.
   * DEV_AUTH and OIDC together are allowed outside production.
   */
  async function reviewedFinding(): Promise<{ svc: AuditService; app: ReturnType<typeof createApp>; id: string; fid: string }> {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const app = createApp(svc, { config: devAuthConfig({ devAuth: true, oidc: oidcCfg }), oidc });
    const auditor = await signIn(app, 'auditor');
    const id = (await auditor.post('/api/engagements', {
      name: 'Pharma', entity: 'Demo Pharma', site: 'OSD', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'GMP',
      scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
    }).expect(201)).body.id as string;
    for (const m of ['scope', 'rcm']) await auditor.post(`/api/engagements/${id}/modules/${m}/run`).expect(200);
    await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
    await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
    const fid = (await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200)).body.engagement.findings[0].id as string;
    const reviewer = await signIn(app, 'reviewer');
    const intent = await reviewer.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action: 'review' }).expect(201);
    const nonce = /name="nonce" value="([^"]+)"/.exec((await reviewer.get(intent.body.reauthUrl)).text)![1];
    await reviewer.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm: 'reviewer' }).expect(200);
    return { svc, app, id, fid };
  }

  /** Signs Priya in through the IdP and returns a session with her CSRF token. */
  async function priyaSession(app: ReturnType<typeof createApp>) {
    mock.setUser(PRIYA);
    const agent = request.agent(app);
    const start = await agent.get('/auth/login').expect(302);
    const back = new URL((await fetch(start.headers.location, { redirect: 'manual' })).headers.get('location')!);
    await agent.get(back.pathname + back.search).expect(200);
    const csrf = (await agent.get('/api/me').expect(200)).body.csrfToken as string;
    return { agent, csrf };
  }

  /** Starts an approval, follows the pop-up to the IdP and back; the callback is sent WITHOUT cookies, like a cross-site redirect. */
  async function approveViaIdp(app: ReturnType<typeof createApp>, id: string, fid: string, asUser: MockUser) {
    const priya = await priyaSession(app);
    const intent = await priya.agent.post(`/api/engagements/${id}/findings/${fid}/sign-intents`).set('x-csrf-token', priya.csrf).send({ action: 'approve', comment: 'agreed' }).expect(201);
    expect(intent.body.method).toBe('oidc');
    const popup = await priya.agent.get(intent.body.reauthUrl).expect(302);
    mock.setUser(asUser);
    const back = new URL((await fetch(popup.headers.location, { redirect: 'manual' })).headers.get('location')!);
    const result = await request(app).get(back.pathname + back.search);
    const status = (await priya.agent.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
    return { intent, popup, result, status };
  }

  it('asks the identity provider for a fresh sign-in and records the signature [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const { popup, result, status, intent } = await approveViaIdp(app, id, fid, PRIYA);
    const authorize = new URL(popup.headers.location);
    expect(authorize.origin).toBe(mock.issuer);
    expect(mock.lastAuthorize()).toMatchObject({ prompt: 'login', max_age: '0', code_challenge_method: 'S256', redirect_uri: oidcCfg.redirectUri });
    expect(result.status).toBe(200);
    expect(result.text).toMatch(/signature was recorded/);
    expect(status).toEqual({ status: 'signed', code: null, message: null });
    const approval = (await listSignatures(svc.db.kysely, id)).find((s) => s.meaning === 'Approved')!;
    expect(approval).toMatchObject({ userName: 'Priya Prakash', role: 'cae', reauthMethod: 'oidc', intentId: intent.body.intentId });
    expect(Date.now() - Date.parse(approval.reauthAt!)).toBeLessThan(60_000);
  });

  it('refuses a re-authentication older than two minutes [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    mock.setAuthTimeOffset(300);
    const { status } = await approveViaIdp(app, id, fid, PRIYA);
    expect(status).toMatchObject({ status: 'failed', code: 'REAUTH_STALE' });
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toEqual([]);
    expect((await readTrail(svc.db.kysely)).some((b) => b.moduleId === 'identity:sign-failed')).toBe(true);
  });

  it('refuses a re-authentication by a different person [REQ-18]', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const { status } = await approveViaIdp(app, id, fid, { sub: 'someone-else', name: 'Someone Else', groups: ['audit-cae'] });
    expect(status).toMatchObject({ status: 'failed', code: 'REAUTH_USER_MISMATCH' });
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toEqual([]);
  });

  it('signs once even if the callback is replayed, and a forged state is not a signing response', async () => {
    const { app, svc, id, fid } = await reviewedFinding();
    const priya = await priyaSession(app);
    const intent = await priya.agent.post(`/api/engagements/${id}/findings/${fid}/sign-intents`).set('x-csrf-token', priya.csrf).send({ action: 'approve' }).expect(201);
    const popup = await priya.agent.get(intent.body.reauthUrl).expect(302);
    const back = new URL((await fetch(popup.headers.location, { redirect: 'manual' })).headers.get('location')!);
    await request(app).get(back.pathname + back.search).expect(200);
    const replay = await request(app).get(back.pathname + back.search);
    expect(replay.text).not.toMatch(/signature was recorded/);
    expect((await listSignatures(svc.db.kysely, id)).filter((s) => s.meaning === 'Approved')).toHaveLength(1);

    back.searchParams.set('state', 'forged');
    const forged = await request(app).get(back.pathname + back.search);
    expect(forged.text).toMatch(/expired/i); // treated as an ordinary login callback without its cookie
  });
});
