import type { EvidenceLink, TestInput } from './types';

/** Empty or absent becomes absent, so no `evidence: []` is ever stored, hashed, trailed or reported. */
export const normaliseEvidence = (links?: EvidenceLink[]): EvidenceLink[] | undefined => (links && links.length ? links : undefined);

type Cited = Pick<TestInput, 'evidence' | 'evidenceRefs'>;

/** How many links and free-text references a test record or finding cites. */
export const evidenceCount = (c: Cited): number => (c.evidence?.length ?? 0) + c.evidenceRefs.length;

/** Whether a test record or finding has any evidence: a link to a document or a free-text reference. */
export const hasEvidence = (c: Cited): boolean => evidenceCount(c) > 0;

const keyOf = (l: EvidenceLink) => `${l.documentId}\u0000${l.page ?? ''}`;

/** The links in `next` whose (document, page) is not already in `previous`: only these are validated on a re-save. */
export function changedLinks(previous: EvidenceLink[] | undefined, next: EvidenceLink[]): EvidenceLink[] {
  const had = new Set((previous ?? []).map(keyOf));
  return next.filter((l) => !had.has(keyOf(l)));
}

export const linkKey = keyOf;

/** The links with duplicates (same document and page) removed, notes trimmed and empty notes dropped. */
export function tidyLinks(links: EvidenceLink[]): EvidenceLink[] {
  const seen = new Set<string>();
  const out: EvidenceLink[] = [];
  for (const l of links) {
    if (seen.has(keyOf(l))) continue;
    seen.add(keyOf(l));
    const note = l.note?.trim();
    out.push({ documentId: l.documentId, ...(l.page !== undefined ? { page: l.page } : {}), ...(note ? { note } : {}) });
  }
  return out;
}
