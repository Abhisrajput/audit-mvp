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
