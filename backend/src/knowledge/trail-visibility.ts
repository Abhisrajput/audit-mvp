import type { Role, TrailBundle } from '../engine/types';
import { CLASSIFICATIONS, mayRead, type Classification } from './access';

/** A trail bundle as one reader may see it. */
export type VisibleTrailBundle = TrailBundle & { redacted?: true };

const isClassification = (v: unknown): v is Classification => typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v);

/**
 * Document registrations and extractions name a document's hash, kind and size of text, which a reader without access to its
 * classification must not see (plan 1D carry-over). The entry stays in place, so the chain's sequence is unbroken;
 * only its details are withheld. Unknown classifications are withheld too.
 */
export function visibleTrail(bundles: TrailBundle[], role: Role): VisibleTrailBundle[] {
  return bundles.map((b) => {
    if (b.moduleId !== 'document:register' && b.moduleId !== 'document:extract') return b;
    const classification = (b.inputs as { classification?: unknown } | null)?.classification;
    if (isClassification(classification) && mayRead(role, classification)) return b;
    return { ...b, inputs: { classification: isClassification(classification) ? classification : null }, output: null, executionLog: [], redacted: true };
  });
}
