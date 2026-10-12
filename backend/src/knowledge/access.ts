import type { Role } from '../engine/types';

export const CLASSIFICATIONS = ['internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const DOCUMENT_KINDS = ['evidence', 'sop', 'policy', 'prior_report', 'regulation', 'okf_concept', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** What each role may read. Admins manage access and see no audit content; viewers see internal material only. */
export const CLASSIFICATIONS_BY_ROLE: Record<Role, readonly Classification[]> = {
  viewer: ['internal'],
  auditor: ['internal', 'confidential'],
  audit_manager: ['internal', 'confidential', 'restricted'],
  cae: ['internal', 'confidential', 'restricted'],
  admin: [],
};

export const mayRead = (role: Role, classification: Classification) => CLASSIFICATIONS_BY_ROLE[role].includes(classification);
