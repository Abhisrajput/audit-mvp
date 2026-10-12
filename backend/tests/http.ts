import request from 'supertest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { AuthConfig } from '../src/auth/config';
import { createApp } from '../src/app';
import type { Db } from '../src/db';
import { newService } from './helpers';

export function devAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    devAuth: true,
    secureCookies: false,
    publicUrl: 'http://localhost:5174',
    session: { idleMinutes: 30, maxHours: 12 },
    oidc: null,
    ...overrides,
  };
}

/** A service on a fresh database with the demo users, behind the real HTTP stack. */
export async function appWithDevUsers(config: AuthConfig = devAuthConfig()) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  return { svc, app: createApp(svc, { config, oidc: null }) };
}

/** Signs in a demo user; the returned helpers carry the session cookie and CSRF token. */
export async function signIn(app: ReturnType<typeof createApp>, userId: string) {
  const agent = request.agent(app);
  await agent.post('/auth/dev-login').send({ userId }).expect(200);
  const me = await agent.get('/api/me').expect(200);
  const csrf = me.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (path: string) => agent.get(path),
    post: (path: string, body: object = {}) => agent.post(path).set('x-csrf-token', csrf).send(body),
    put: (path: string, body: object) => agent.put(path).set('x-csrf-token', csrf).send(body),
    patch: (path: string, body: object) => agent.patch(path).set('x-csrf-token', csrf).send(body),
  };
}

/**
 * Makes every trail insert for the given identity events fail inside Postgres,
 * so a route that writes state and trail in one transaction must roll back both.
 * A trigger on this test's own database exercises real rollback without mocking modules.
 */
export async function failTrailWrites(db: Db, moduleIds: string[]) {
  const list = moduleIds.map((m) => `'${m.replace(/'/g, "''")}'`).join(', ');
  await db.execScript(`
    CREATE OR REPLACE FUNCTION test_fail_trail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.module_id = ANY (ARRAY[${list}]::text[]) THEN RAISE EXCEPTION 'trail unavailable (test)'; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_fail_trail ON trail;
    CREATE TRIGGER test_fail_trail BEFORE INSERT ON trail FOR EACH ROW EXECUTE FUNCTION test_fail_trail();`);
}

/** Lets the trail accept writes again. */
export async function restoreTrailWrites(db: Db) {
  await db.execScript('DROP TRIGGER IF EXISTS test_fail_trail ON trail;');
}

export type Session = Awaited<ReturnType<typeof signIn>>;

/** Runs the pharma chain as the auditor until one draft finding exists. */
export async function draftFinding(app: Awaited<ReturnType<typeof appWithDevUsers>>['app']) {
  const auditor = await signIn(app, 'auditor');
  const created = await auditor.post('/api/engagements', {
    name: 'Pharma self-inspection', entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30',
    auditType: 'GMP self-inspection', scopeStatement: 'Data integrity: HPLC audit trails and user access', packIds: ['pharma'],
  }).expect(201);
  const id = created.body.id as string;
  await auditor.post(`/api/engagements/${id}/modules/scope/run`).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/rcm/run`).expect(200);
  await auditor.put(`/api/engagements/${id}/tests/PH-DI-01`, { designAdequate: true, observation: 'Audit trail review missing for 5 of 20 sequences', evidenceRefs: ['SEQ-Q2'], sampleTested: 20, exceptions: 5 }).expect(200);
  await auditor.post(`/api/engagements/${id}/modules/testing/run`).expect(200);
  const gaps = await auditor.post(`/api/engagements/${id}/modules/gaps/run`).expect(200);
  return { auditor, id, fid: gaps.body.engagement.findings[0].id as string };
}

/** The signing pop-up for a demo user: start, read the form, confirm. */
export async function devSign(user: Session, userId: string, id: string, fid: string, action: string, confirm = userId) {
  const intent = await user.post(`/api/engagements/${id}/findings/${fid}/sign-intents`, { action, comment: 'agreed' });
  if (intent.status !== 201) return { intent, status: null as null | { status: string; code: string | null } };
  const popup = await user.get(intent.body.reauthUrl).expect(200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(popup.text)![1];
  const done = await user.agent.post(`${intent.body.reauthUrl}/dev`).type('form').send({ nonce, confirm });
  const status = (await user.get(`/api/sign-intents/${intent.body.intentId}`).expect(200)).body;
  return { intent, popup, done, nonce, status };
}
