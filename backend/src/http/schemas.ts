import { z } from 'zod';
import type { Clause, Impact, Likelihood } from '../engine/types';
import { EngagementContextInputSchema } from '../judgment/context';
import { IMPACTS, LIKELIHOODS } from '../judgment/finding';
import { TOLERANCE_MAX } from '../judgment/sampling';
import { METHODOLOGY_PACK_ID } from '../judgment/standards';
import type { AuditService } from '../service';

// Request bodies shared by the HTTP routes and the assistant's commands, so both accept exactly the same input.

export const NewEngagementSchema = z.object({
  name: z.string().min(1),
  entity: z.string().min(1),
  site: z.string().min(1),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
  auditType: z.string().min(1),
  scopeStatement: z.string().min(1),
  packIds: z.array(z.string()).min(1),
  context: EngagementContextInputSchema.optional(),
});

export const EvidenceLinkSchema = z.object({
  documentId: z.string().min(1).max(64),
  page: z.number().int().positive().optional(),
  note: z.string().max(200).optional(),
}).strict();

export const TestInputSchema = z.object({
  designAdequate: z.boolean().nullable(),
  observation: z.string(),
  evidenceRefs: z.array(z.string().min(1)),
  evidence: z.array(EvidenceLinkSchema).max(50).optional(),
  sampleTested: z.number().int().min(0),
  exceptions: z.number().int().min(0),
  fromDraft: z.object({ runId: z.string().min(1), at: z.string().min(1) }).strict().optional(),
});

export const FindingPatchSchema = z
  .object({
    title: z.string().min(1),
    likelihood: z.enum([...LIKELIHOODS] as [Likelihood, ...Likelihood[]]),
    impact: z.enum([...IMPACTS] as [Impact, ...Impact[]]),
    condition: z.string().min(1),
    criteria: z.string().min(1),
    cause: z.string().min(1),
    effect: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    evidence: z.array(EvidenceLinkSchema).max(50),
  })
  .partial()
  .strict();

export const ToleranceSchema = z.object({ rate: z.number().min(0).max(TOLERANCE_MAX) }).strict();

export const ResponseInputSchema = z.object({
  response: z.enum(['agree', 'partially_agree', 'disagree']), owner: z.string().trim().min(1).max(200),
  dueDate: z.iso.date().nullable().optional(), actionPlan: z.string().max(4000).optional(),
}).strict();

/** Clause search over the named packs (default: every pack but the methodology one); the body of GET /api/search. */
export function searchClauses(svc: AuditService, q: string, packIds?: string[]): { clauseId: string; score: number; clause: Clause | undefined }[] {
  const ids = packIds ?? svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID).map((p) => p.id);
  const allowed = new Set(svc.registry.clausesFor(ids).map((c) => c.id));
  const hits = svc.grounding.clauses.search(q, 10, (id) => allowed.has(id));
  return hits.map((h) => ({ ...h, clause: svc.registry.clauses.get(h.clauseId) }));
}
