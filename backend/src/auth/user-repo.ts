import crypto from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { Executor } from '../db/trail-repo';
import type { UsersTable } from '../db/schema';
import type { Role } from '../engine/types';

export interface UserRecord {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  /** null until a role is mapped from the identity provider or assigned by an admin ("pending access"). */
  role: Role | null;
  /** 'admin' once an administrator has set the role; identity-provider groups no longer change it. */
  roleSource: 'idp' | 'admin';
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProvisionInput {
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  idpRole: Role | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export function toUserRecord(row: Selectable<UsersTable>): UserRecord {
  return {
    id: row.id, issuer: row.issuer, subject: row.subject, name: row.name, email: row.email, role: row.role,
    roleSource: row.role_source, active: row.active, createdAt: iso(row.created_at), lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
  };
}

/**
 * Creates the user on first sign-in, or refreshes name, email and last login.
 * The role follows the identity provider unless an admin has set it.
 */
export async function provisionUser(db: Executor, p: ProvisionInput): Promise<UserRecord> {
  const now = new Date().toISOString();
  const row = await db
    .insertInto('users')
    .values({
      id: `U-${crypto.randomBytes(6).toString('hex')}`,
      issuer: p.issuer, subject: p.subject, name: p.name, email: p.email, role: p.idpRole, role_source: 'idp', last_login_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['issuer', 'subject']).doUpdateSet({
        name: (eb) => eb.ref('excluded.name'),
        email: (eb) => eb.ref('excluded.email'),
        last_login_at: (eb) => eb.ref('excluded.last_login_at'),
        role: sql<Role | null>`CASE WHEN users.role_source = 'idp' THEN excluded.role ELSE users.role END`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toUserRecord(row);
}

export async function getUser(db: Executor, id: string): Promise<UserRecord | null> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toUserRecord(row) : null;
}

export async function listUsers(db: Executor): Promise<UserRecord[]> {
  return (await db.selectFrom('users').selectAll().orderBy('id').execute()).map(toUserRecord);
}

export async function setUserRole(db: Executor, id: string, role: Role | null): Promise<UserRecord | null> {
  const row = await db.updateTable('users').set({ role, role_source: 'admin' }).where('id', '=', id).returningAll().executeTakeFirst();
  return row ? toUserRecord(row) : null;
}

export async function setUserActive(db: Executor, id: string, active: boolean): Promise<UserRecord | null> {
  const row = await db.updateTable('users').set({ active }).where('id', '=', id).returningAll().executeTakeFirst();
  return row ? toUserRecord(row) : null;
}
