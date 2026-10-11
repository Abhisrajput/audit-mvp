import type { Role } from './types';

export const ROLE_LABEL: Record<Role, string> = {
  auditor: 'Auditor',
  audit_manager: 'Audit manager',
  cae: 'Chief Audit Executive',
  admin: 'Administrator',
  viewer: 'Viewer',
};

/** May create engagements, run modules, record tests and edit findings. */
export const canPrepare = (role: Role | null | undefined) => role === 'auditor' || role === 'audit_manager';
