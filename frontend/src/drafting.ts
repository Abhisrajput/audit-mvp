import { api } from './api';
import type { Engagement, EvidenceLink, TestDraft } from './types';

/** The Fieldwork card's form fields, all strings except the evidence links. */
export type FormState = { designAdequate: string; observation: string; evidenceRefs: string; evidence: EvidenceLink[]; sampleTested: string; exceptions: string };

/** What Accept copies into the form: the proposal as strings, the evidence as links (no quotes, no notes). */
export function draftToForm(draft: TestDraft): Partial<FormState> {
  const seen = new Set<string>();
  const evidence: EvidenceLink[] = [];
  for (const e of draft.evidence) {
    const key = `${e.documentId}#${e.page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(e.page === undefined ? { documentId: e.documentId } : { documentId: e.documentId, page: e.page });
  }
  const p = draft.proposal;
  if (!p) return { evidence };
  return {
    designAdequate: p.designAdequate === null ? 'na' : p.designAdequate ? 'yes' : 'no',
    sampleTested: String(p.sampleTested),
    exceptions: String(p.exceptions),
    observation: p.observation,
    evidence,
  };
}

/** A draft can be accepted when it proposes a result and nothing blocks it. */
export const acceptable = (draft: TestDraft): boolean => !!draft.proposal && draft.qa.blocking.length === 0;

export function confidenceColor(c: TestDraft['confidence']): 'success' | 'warning' | 'default' {
  return c === 'high' ? 'success' : c === 'medium' ? 'warning' : 'default';
}

export const discardDraft = (engagementId: string, rowId: string, version?: number): Promise<Engagement> =>
  api<Engagement>(`/engagements/${engagementId}/tests/${rowId}/draft/discard`, { method: 'POST', ifMatch: version });

/** The pair a human save sends to say it came from this draft; none unless Accept was pressed and a proposal remains. */
export function fromDraftFor(draft: TestDraft | undefined, accepted: boolean): { runId: string; at: string } | undefined {
  return accepted && draft?.proposal ? { runId: draft.draftedBy.runId, at: draft.draftedBy.at } : undefined;
}
