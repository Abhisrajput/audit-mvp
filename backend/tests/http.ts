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
