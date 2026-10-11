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
 * The rows are the record; the finding's JSONB is only a convenient copy and can be edited behind the application.
 * - With a signatureId: broken unless a row with that id exists for this finding, by the same person with the same
 *   meaning, and its content hash equals both the hash recorded on the sign-off and the finding's current content hash.
 * - Without one: broken if a row exists for this finding, person and meaning (its id was stripped), else legacy
 *   (signed before Part 11 signing, or imported; never treated as re-authenticated).
 * - A sign-off backed by a row shows the row's name, role, meaning, time, re-authentication and id.
 * - A row for this finding that no sign-off accounts for, on the finding's current content, is reported in
 *   `signatureIssues` (a sign-off was removed). Rows on earlier content are history: the finding was edited since.
 * The copy is for responses and exports only; it is never saved.
 */
export function withSignatureStatus(e: Engagement, rows: SignatureRow[]): Engagement {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ...e,
    findings: e.findings.map((f) => {
      const current = findingContentHash(f);
      const mine = rows.filter((r) => r.findingId === f.id);
      const used = new Set<string>();
      const fromRow = (s: SignOff, row: SignatureRow, broken: boolean): SignOff => {
        used.add(row.id);
        return {
          ...s, userName: row.userName, role: row.role, meaning: row.meaning, at: row.signedAt,
          reauth: { method: row.reauthMethod, at: row.reauthAt }, signatureId: row.id, broken, legacy: false,
        };
      };
      // Sign-offs that name their row first, so a stripped one cannot take a row another sign-off names.
      const named = f.signOffs.map((s): SignOff | null => {
        if (!s.signatureId) return null;
        const row = byId.get(s.signatureId);
        if (!row || row.findingId !== f.id || row.userId !== s.userId || row.meaning !== s.meaning) {
          if (row) used.add(row.id);
          return { ...s, broken: true, legacy: false };
        }
        return fromRow(s, row, !(row.contentHash === s.contentHash && row.contentHash === current));
      });
      const signOffs = f.signOffs.map((s, i): SignOff => {
        if (named[i]) return named[i]!;
        const candidates = mine.filter((r) => r.userId === s.userId && r.meaning === s.meaning);
        const row = candidates.find((r) => !used.has(r.id) && r.contentHash === current) ?? candidates.find((r) => !used.has(r.id)) ?? candidates.at(-1);
        return row ? fromRow(s, row, true) : { ...s, broken: false, legacy: true };
      });
      const issues = mine
        .filter((r) => !used.has(r.id) && r.contentHash === current)
        .map((r) => `Signature ${r.id} (${r.meaning} by ${r.userName}) is recorded but missing from the finding`);
      const shown: Finding = { ...f, signOffs };
      if (issues.length) shown.signatureIssues = issues;
      else delete shown.signatureIssues;
      return shown;
    }),
  };
}

/** The status of a sign-off already checked by withSignatureStatus. */
export function signatureState(s: SignOff): 'valid' | 'broken' | 'legacy' {
  if (s.legacy || !s.signatureId) return 'legacy';
  return s.broken ? 'broken' : 'valid';
}
