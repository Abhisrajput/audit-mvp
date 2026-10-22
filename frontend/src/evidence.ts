import { api, upload } from './api';
import { plainSnippet } from './assistant';
import type { Classification, DocumentExtraction, DocumentKind, DocumentRecord } from './types';

// access.ts is pure (type-only imports), so these values are safe in the browser bundle.
export { CLASSIFICATIONS, CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS } from '../../backend/src/knowledge/access';
export type { Classification, DocumentExtraction, DocumentKind, DocumentRecord };

export interface StatusLabel { label: string; color: 'default' | 'success' | 'warning' | 'error'; retry: boolean }

export function statusLabel(extraction: (Pick<DocumentExtraction, 'status'> & Partial<Pick<DocumentExtraction, 'pages'>>) | null): StatusLabel {
  if (!extraction) return { label: 'Pending', color: 'default', retry: false };
  switch (extraction.status) {
    case 'ok':
      return { label: extraction.pages ? `Text (${extraction.pages} ${extraction.pages === 1 ? 'page' : 'pages'})` : 'Text', color: 'success', retry: false };
    case 'client':
      return { label: 'Text', color: 'success', retry: false };
    case 'no_text':
      return { label: 'No text', color: 'warning', retry: false };
    case 'failed':
      return { label: 'Failed', color: 'error', retry: true };
    case 'too_large':
      return { label: 'Too large', color: 'warning', retry: true };
    case 'unsupported':
      return { label: 'Stored', color: 'default', retry: false };
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface UploadFields { kind: DocumentKind; classification: Classification; retainUntil?: string; note?: string }
/** 201 is a new document; a 200 for bytes already in the scope carries duplicate: true. */
export type UploadResult = DocumentRecord & { duplicate?: boolean };

const toFields = (f: UploadFields): Record<string, string> => {
  const out: Record<string, string> = { kind: f.kind, classification: f.classification };
  if (f.retainUntil) out.retainUntil = f.retainUntil;
  if (f.note && f.note.trim()) out.note = f.note;
  return out;
};

export const uploadEvidence = (engagementId: string, file: File, fields: UploadFields, onProgress?: (fraction: number) => void) =>
  upload<UploadResult>(`/engagements/${engagementId}/evidence`, file, toFields(fields), onProgress);

export const uploadGlobal = (file: File, fields: UploadFields, onProgress?: (fraction: number) => void) =>
  upload<UploadResult>('/documents/upload', file, toFields(fields), onProgress);

export const retryExtraction = (id: string) => api<DocumentRecord>(`/documents/${id}/extract`, { method: 'POST', body: {} });

export interface DocumentText { page: number | null; pages: number | null; text: string }
export const documentText = (id: string, page?: number) => api<DocumentText>(`/documents/${id}/text${page ? `?page=${page}` : ''}`);

export const listDocuments = (engagementId?: string) => api<DocumentRecord[]>(`/documents${engagementId ? `?engagementId=${encodeURIComponent(engagementId)}` : ''}`);

export interface SearchRow { documentId: string; filename: string; page: number | null; snippet: string }
interface RawHit { kind: string; snippet: string; citation: { documentId?: string; filename?: string; page?: number | null } }

export async function searchEvidence(engagementId: string | undefined, q: string): Promise<SearchRow[]> {
  const qs = `${engagementId ? `engagementId=${encodeURIComponent(engagementId)}&` : ''}q=${encodeURIComponent(q)}`;
  const hits = await api<RawHit[]>(`/knowledge/search?${qs}`);
  return hits.flatMap((h) => (h.kind === 'chunk' && h.citation.documentId
    ? [{ documentId: h.citation.documentId, filename: h.citation.filename ?? h.citation.documentId, page: h.citation.page ?? null, snippet: plainSnippet(h.snippet) }]
    : []));
}
