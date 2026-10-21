// Engagement context: the facts an auditor enters about the business that bear on
// risk (spec §3.1). This file holds the schema for that input and the small helpers
// that find which facts apply to a process area. It does no I/O.

import { z } from 'zod';
import type { ContextFactor, EngagementContext, FactorKind } from '../engine/types';

/** The kinds of fact an auditor can record, in the order the form offers them. */
export const FACTOR_KINDS: readonly FactorKind[] = ['change', 'incident', 'regulatory', 'prior_finding', 'complexity'];

/** Size limits for the context input. The schema below uses these, so they cannot drift. */
export const CONTEXT_LIMITS = { factors: 50, description: 500, background: 4000 } as const;

/** What the auditor sends when saving the context. The server adds who and when. */
export interface EngagementContextInput { factors: ContextFactor[]; background: string }

/** The request body: no updatedBy/updatedAt. Process areas are trimmed and must not be blank. */
export const EngagementContextInputSchema: z.ZodType<EngagementContextInput> = z.object({
  factors: z
    .array(
      z.object({
        kind: z.enum(FACTOR_KINDS),
        processAreas: z.array(z.string().trim().min(1)),
        description: z.string().max(CONTEXT_LIMITS.description),
      }),
    )
    .max(CONTEXT_LIMITS.factors),
  background: z.string().max(CONTEXT_LIMITS.background),
});

/** Factors that apply to a process area: those naming it, plus those with empty processAreas (the whole entity). */
export function factorsFor(context: EngagementContext | null, processArea: string): ContextFactor[] {
  if (!context) return [];
  return context.factors.filter((factor) => factor.processAreas.length === 0 || factor.processAreas.includes(processArea));
}

/** Areas named by any factor. */
export function namedAreas(context: EngagementContext | null): string[] {
  if (!context) return [];
  return [...new Set(context.factors.flatMap((factor) => factor.processAreas))];
}

/** What the basis hashes: content only, never who or when. */
export function contextBasis(context: EngagementContext | null): { factors: ContextFactor[]; background: string } | undefined {
  if (!context) return undefined;
  return { factors: context.factors, background: context.background };
}
