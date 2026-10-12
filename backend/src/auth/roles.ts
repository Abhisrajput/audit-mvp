import type { Role } from '../engine/types';

export const ROLES: readonly Role[] = ['auditor', 'audit_manager', 'cae', 'admin', 'viewer'];

/** Roles that may read audit content. Admins manage access only and see no audit content. */
export const READ_ROLES: readonly Role[] = ['auditor', 'audit_manager', 'cae', 'viewer'];

/** Roles that prepare audit work: create engagements, run modules, record tests, edit findings. */
export const PREPARER_ROLES: readonly Role[] = ['auditor', 'audit_manager'];

/** May sign a finding as Reviewed. */
export const REVIEWER_ROLES: readonly Role[] = ['audit_manager'];

/** May sign a finding as Approved or Rejected. */
export const APPROVER_ROLES: readonly Role[] = ['cae'];

/** When identity-provider groups map to several roles, the first role in this order wins. */
export const ROLE_PRECEDENCE: readonly Role[] = ['cae', 'audit_manager', 'auditor', 'admin', 'viewer'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
