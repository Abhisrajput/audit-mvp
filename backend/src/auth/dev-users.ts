import type { Executor } from '../db/trail-repo';
import type { User } from '../engine/types';

// Demo identities for DEV_AUTH (never available in production). The first three
// keep the MVP's ids so existing trail entries still name the same people.

export const DEV_ISSUER = 'dev';

export const DEV_USERS: User[] = [
  { id: 'auditor', name: 'Asha Auditor', role: 'auditor' },
  { id: 'reviewer', name: 'Ravi Reviewer', role: 'audit_manager' },
  { id: 'approver', name: 'Priya QA Head', role: 'cae' },
  { id: 'admin', name: 'Arun Admin', role: 'admin' },
  { id: 'viewer', name: 'Vera Viewer', role: 'viewer' },
];

export function devUser(id: string | undefined): User | undefined {
  return DEV_USERS.find((u) => u.id === id);
}

/** Inserts the demo users if missing. Their roles count as admin-set, so they never drift. */
export async function ensureDevUsers(db: Executor): Promise<void> {
  await db
    .insertInto('users')
    .values(DEV_USERS.map((u) => ({ id: u.id, issuer: DEV_ISSUER, subject: u.id, name: u.name, email: null, role: u.role, role_source: 'admin' as const })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}
