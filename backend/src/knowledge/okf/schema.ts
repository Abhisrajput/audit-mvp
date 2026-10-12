import { z } from 'zod';
import { CLASSIFICATIONS } from '../access';

// Frontmatter schemas for OKF v0.2 concepts plus the audit extensions under x_audit (spec §6.2).
// Objects are strict, so a misspelt field is an error rather than silently ignored.

export const CONCEPT_DIRS = {
  regulations: 'regulation',
  clauses: 'clause',
  controls: 'control',
  risks: 'risk',
  eval: 'eval_case',
} as const;

export type ConceptType = 'pack' | (typeof CONCEPT_DIRS)[keyof typeof CONCEPT_DIRS];

/** File-name slug of a concept id: "21CFR211.22" -> "21cfr211-22". */
export const slugOf = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'must be a real calendar date');

const okf = {
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  sources: z.array(z.strictObject({ ref: z.string().min(1) })).default([]),
  generated: z.strictObject({ by: z.string().min(1), at: IsoDate }).nullable().default(null),
  verified: z.strictObject({ by: z.string().min(1), role: z.string().min(1), at: IsoDate }).nullable().default(null),
  status: z.enum(['active', 'deprecated']),
  stale_after: IsoDate.nullable().default(null),
};

export const RISK_RATINGS = ['High', 'Medium', 'Low'] as const;
export const CONTROL_TYPES = ['Preventive', 'Detective'] as const;
export const CONTROL_NATURES = ['Manual', 'Automated', 'IT-dependent manual'] as const;
export const FREQUENCIES = ['Annual', 'Quarterly', 'Monthly', 'Weekly', 'Daily', 'Per event', 'Per batch'] as const;

export const PackConcept = z.strictObject({
  type: z.literal('pack'),
  ...okf,
  description: z.string().default(''),
  x_audit: z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-case pack id'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version such as 0.2.0'),
    vertical: z.string().min(1),
    classification: z.enum(CLASSIFICATIONS).default('internal'),
    /** Short citation prefix per regulation name, e.g. {"EU GMP Part I": "EU GMP"}. */
    citation_prefixes: z.record(z.string(), z.string()).default({}),
  }),
});

export const ClauseConcept = z.strictObject({
  type: z.literal('clause'),
  ...okf,
  description: z.string().min(1),
  x_audit: z.strictObject({ id: z.string().min(1), regulation: z.string().min(1), ref: z.string().min(1) }),
});

export const ControlConcept = z.strictObject({
  type: z.literal('control'),
  ...okf,
  x_audit: z.strictObject({
    id: z.string().min(1),
    process_area: z.string().min(1),
    risk: z.string().min(1),
    risk_rating: z.enum(RISK_RATINGS),
    type: z.enum(CONTROL_TYPES),
    nature: z.enum(CONTROL_NATURES),
    frequency: z.enum(FREQUENCIES),
    clause_refs: z.array(z.string().min(1)).min(1),
    evidence_expected: z.array(z.string().min(1)).min(1),
  }),
});

export const EvalCaseConcept = z.strictObject({
  type: z.literal('eval_case'),
  ...okf,
  description: z.string(),
  x_audit: z.strictObject({
    id: z.string().min(1),
    kind: z.enum(['retrieval', 'testing', 'gaps']),
    input: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
  }),
});

/** Regulations and risks: accepted and graphed; the MVP packs have none (regulation names live on clauses). */
const OpenConcept = (type: 'regulation' | 'risk') =>
  z.strictObject({ type: z.literal(type), ...okf, x_audit: z.looseObject({ id: z.string().min(1) }) });

export const CONCEPT_SCHEMAS = {
  pack: PackConcept,
  clause: ClauseConcept,
  control: ControlConcept,
  eval_case: EvalCaseConcept,
  regulation: OpenConcept('regulation'),
  risk: OpenConcept('risk'),
} satisfies Record<ConceptType, z.ZodType>;

export type PackAttrs = z.infer<typeof PackConcept>['x_audit'];
export type ClauseAttrs = z.infer<typeof ClauseConcept>['x_audit'];
export type ControlAttrs = z.infer<typeof ControlConcept>['x_audit'];
export type EvalCaseAttrs = z.infer<typeof EvalCaseConcept>['x_audit'];
