import crypto from 'node:crypto';
import type { Executor } from '../db/trail-repo';
import { toUserRecord, type UserRecord } from './user-repo';

export interface SessionPolicy {
  idleMinutes: number;
  maxHours: number;
}

export interface ActiveSession {
  /** SHA-256 of the cookie token. */
  sessionId: string;
  user: UserRecord;
  csrfToken: string;
}

/** last_seen_at is refreshed at most this often, so reads don't write on every request. */
const TOUCH_INTERVAL_MS = 60_000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

export async function createSession(db: Executor, userId: string): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  await db.insertInto('sessions').values({ id: sha256(token), user_id: userId, csrf_token: csrfToken }).execute();
  return { token, csrfToken };
}

/**
 * The live session for a cookie token, or null when it is unknown, revoked,
 * idle too long, past its absolute lifetime, or its user is deactivated.
 * The user (and so the role) is read fresh on every call.
 */
export async function resolveSession(db: Executor, token: string, policy: SessionPolicy, now = new Date()): Promise<ActiveSession | null> {
  const id = sha256(token);
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.csrf_token', 's.created_at as session_created_at', 's.last_seen_at', 's.revoked_at',
      'u.id', 'u.issuer', 'u.subject', 'u.name', 'u.email', 'u.role', 'u.role_source', 'u.active', 'u.created_at', 'u.last_login_at',
    ])
    .where('s.id', '=', id)
    .executeTakeFirst();
  if (!row || row.revoked_at || !row.active) return null;

  const t = now.getTime();
  const lastSeen = new Date(row.last_seen_at).getTime();
  const expired =
    t - new Date(row.session_created_at).getTime() > policy.maxHours * 3_600_000 || t - lastSeen > policy.idleMinutes * 60_000;
  if (expired) {
    await db.updateTable('sessions').set({ revoked_at: now.toISOString() }).where('id', '=', id).where('revoked_at', 'is', null).execute();
    return null;
  }
  if (t - lastSeen > TOUCH_INTERVAL_MS) {
    await db.updateTable('sessions').set({ last_seen_at: now.toISOString() }).where('id', '=', id).execute();
  }
  return { sessionId: id, csrfToken: row.csrf_token, user: toUserRecord(row) };
}

export async function revokeSession(db: Executor, token: string): Promise<boolean> {
  const res = await db
    .updateTable('sessions')
    .set({ revoked_at: new Date().toISOString() })
    .where('id', '=', sha256(token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

export async function revokeUserSessions(db: Executor, userId: string): Promise<number> {
  const res = await db
    .updateTable('sessions')
    .set({ revoked_at: new Date().toISOString() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}
