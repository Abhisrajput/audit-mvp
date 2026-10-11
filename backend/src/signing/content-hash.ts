import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement, Finding } from '../engine/types';

/** SHA-256 of what a finding says — the part a signature vouches for. Status, sign-offs and preparers are not content. */
export function findingContentHash(f: Finding): string {
  const { id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs } = f;
  return sha256(canonicalJson({ id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs }));
}

/** A copy of the engagement for display, with each signed sign-off marked broken if the content no longer matches. */
export function withSignatureStatus(e: Engagement): Engagement {
  return {
    ...e,
    findings: e.findings.map((f) => {
      const current = findingContentHash(f);
      return { ...f, signOffs: f.signOffs.map((s) => (s.contentHash ? { ...s, broken: s.contentHash !== current } : s)) };
    }),
  };
}
