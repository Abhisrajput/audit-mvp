import { canonicalJson, sha256 } from '../engine/trail';
import type { SignatureRow } from '../db/signature-repo';
import type { Engagement, Finding, SignOff } from '../engine/types';

/** SHA-256 of what a finding says — the part a signature vouches for. Status, sign-offs and preparers are not content. */
export function findingContentHash(f: Finding): string {
  const { id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs } = f;
  return sha256(canonicalJson({ id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs }));
}

/**
 * A copy of the engagement for display, with each sign-off checked against the append-only `signatures` rows.
 * - No signatureId: legacy (signed before Part 11 signing, or imported); never treated as re-authenticated.
 * - Otherwise broken unless a row with that id exists for this finding, by the same person with the same meaning,
 *   and its content hash equals both the hash recorded on the sign-off and the finding's current content hash.
 * The row is the reference: rewriting the finding and its recorded hash together still breaks the signature.
 */
export function withSignatureStatus(e: Engagement, rows: SignatureRow[]): Engagement {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ...e,
    findings: e.findings.map((f) => {
      const current = findingContentHash(f);
      return {
        ...f,
        signOffs: f.signOffs.map((s): SignOff => {
          if (!s.signatureId) return { ...s, broken: false, legacy: true };
          const row = byId.get(s.signatureId);
          const intact = !!row && row.findingId === f.id && row.userId === s.userId && row.meaning === s.meaning
            && row.contentHash === s.contentHash && row.contentHash === current;
          return { ...s, broken: !intact, legacy: false };
        }),
      };
    }),
  };
}

/** The status of a sign-off already checked by withSignatureStatus. */
export function signatureState(s: SignOff): 'valid' | 'broken' | 'legacy' {
  if (s.legacy || !s.signatureId) return 'legacy';
  return s.broken ? 'broken' : 'valid';
}
