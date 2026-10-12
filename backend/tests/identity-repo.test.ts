import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { recordIdentityEvent } from '../src/auth/identity-trail';
import { createSession, resolveSession, revokeSession, revokeUserSessions } from '../src/auth/session-repo';
import { getUser, listUsers, provisionUser, setUserActive, setUserRole } from '../src/auth/user-repo';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { testDb } from './db';

const POLICY = { idleMinutes: 30, maxHours: 12 };
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const idp = (sub: string, idpRole: 'auditor' | 'cae' | null = 'auditor') => ({
  issuer: 'https://idp.example.com', subject: sub, name: `User ${sub}`, email: `${sub}@example.com`, idpRole,
});

describe('users', () => {
  it('provisions an identity-provider user once and follows later role changes from the IdP', async () => {
    const db = (await testDb()).kysely;
    const first = await provisionUser(db, idp('s1', 'auditor'));
    expect(first).toMatchObject({ role: 'auditor', roleSource: 'idp', active: true, email: 's1@example.com' });
    expect(first.id).toMatch(/^U-[0-9a-f]{12}$/);
    const again = await provisionUser(db, idp('s1', 'cae'));
    expect(again.id).toBe(first.id);
    expect(again.role).toBe('cae');
    expect(again.lastLoginAt).not.toBeNull();
  });

  it('keeps a role set by an admin even when the IdP says otherwise', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s2', null));
    expect(u.role).toBeNull();
    await setUserRole(db, u.id, 'audit_manager');
    const later = await provisionUser(db, idp('s2', 'auditor'));
    expect(later).toMatchObject({ role: 'audit_manager', roleSource: 'admin' });
  });

  it('creates exactly one user when the same person signs in twice at once', async () => {
    const db = (await testDb()).kysely;
    await Promise.all([provisionUser(db, idp('s3')), provisionUser(db, idp('s3'))]);
    expect((await listUsers(db)).filter((u) => u.subject === 's3')).toHaveLength(1);
  });

  it('never deletes users, and seeds the demo users idempotently', async () => {
    const db = (await testDb()).kysely;
    await ensureDevUsers(db);
    await ensureDevUsers(db);
    expect((await listUsers(db)).map((u) => [u.id, u.role])).toEqual([
      ['admin', 'admin'], ['approver', 'cae'], ['auditor', 'auditor'], ['reviewer', 'audit_manager'], ['viewer', 'viewer'],
    ]);
    await expect(db.deleteFrom('users').where('id', '=', 'auditor').execute()).rejects.toThrow(/append-only: DELETE/);
    expect(await getUser(db, 'nobody')).toBeNull();
  });
});

describe('sessions', () => {
  it('resolves a fresh session and never stores the raw token', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s4'));
    const { token, csrfToken } = await createSession(db, u.id);
    const s = await resolveSession(db, token, POLICY);
    expect(s).toMatchObject({ csrfToken, user: { id: u.id, role: 'auditor' } });
    const stored = await db.selectFrom('sessions').select('id').execute();
    expect(stored.map((r) => r.id)).not.toContain(token);
    expect(await resolveSession(db, 'not-a-token', POLICY)).toBeNull();
  });

  it('expires after 30 idle minutes and after 12 hours however active', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s5'));
    const idle = await createSession(db, u.id);
    expect(await resolveSession(db, idle.token, POLICY, minutes(31))).toBeNull();
    expect(await resolveSession(db, idle.token, POLICY)).toBeNull(); // revoked once expired

    const busy = await createSession(db, u.id);
    for (let m = 20; m <= 700; m += 20) expect(await resolveSession(db, busy.token, POLICY, minutes(m))).not.toBeNull();
    expect(await resolveSession(db, busy.token, POLICY, minutes(12 * 60 + 1))).toBeNull();
  });

  it('stops working after logout, revocation or deactivation', async () => {
    const db = (await testDb()).kysely;
    const u = await provisionUser(db, idp('s6'));
    const a = await createSession(db, u.id);
    expect(await revokeSession(db, a.token)).toBe(true);
    expect(await resolveSession(db, a.token, POLICY)).toBeNull();

    const b = await createSession(db, u.id);
    const c = await createSession(db, u.id);
    expect(await revokeUserSessions(db, u.id)).toBe(2);
    expect(await resolveSession(db, b.token, POLICY)).toBeNull();
    expect(await resolveSession(db, c.token, POLICY)).toBeNull();

    const d = await createSession(db, u.id);
    await setUserActive(db, u.id, false);
    expect(await resolveSession(db, d.token, POLICY)).toBeNull();
  });
});

describe('identity events', () => {
  it('seals identity events into the same chain with no engagement', async () => {
    const db = (await testDb()).kysely;
    await db.transaction().execute((trx) => recordIdentityEvent(trx, 'login', { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, { method: 'dev' }, { userId: 'auditor' }));
    await db.transaction().execute((trx) => recordIdentityEvent(trx, 'logout', { id: 'auditor', name: 'Asha Auditor', role: 'auditor' }, {}, {}));
    const trail = await readTrail(db);
    expect(trail.map((b) => [b.moduleId, b.engagementId, b.actor])).toEqual([
      ['identity:login', null, 'auditor'],
      ['identity:logout', null, 'auditor'],
    ]);
    expect(verifyChain(trail).valid).toBe(true);
  });
});
