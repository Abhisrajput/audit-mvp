import { describe, expect, it } from 'vitest';
import { setCsrfToken, uploadHeaders } from './api';
import { formatSize, isPreparer, linkLabel, mergeDocuments, statusLabel, toggleLink } from './evidence';
import type { DocumentExtraction } from './evidence';

const ex = (status: DocumentExtraction['status'], pages: number | null = null): DocumentExtraction =>
  ({ status, extractor: 'x', version: '1', chars: 10, pages, error: null, at: '2026-10-22T00:00:00Z' });

describe('statusLabel', () => {
  it('labels every extraction outcome', () => {
    expect(statusLabel(ex('ok', 3))).toEqual({ label: 'Text (3 pages)', color: 'success', retry: false });
    expect(statusLabel(ex('ok', 1))).toEqual({ label: 'Text (1 page)', color: 'success', retry: false });
    expect(statusLabel(ex('ok'))).toEqual({ label: 'Text', color: 'success', retry: false });
    expect(statusLabel(ex('no_text'))).toEqual({ label: 'No text', color: 'warning', retry: false });
    expect(statusLabel(ex('failed'))).toEqual({ label: 'Failed', color: 'error', retry: true });
    expect(statusLabel(ex('too_large'))).toEqual({ label: 'Too large', color: 'warning', retry: true });
    expect(statusLabel(ex('unsupported'))).toEqual({ label: 'Stored', color: 'default', retry: false });
    expect(statusLabel(ex('client'))).toEqual({ label: 'Text', color: 'success', retry: false });
    expect(statusLabel(null)).toEqual({ label: 'Pending', color: 'default', retry: false });
  });
});

describe('formatSize', () => {
  it('uses B, KB and MB', () => {
    expect(formatSize(900)).toBe('900 B');
    expect(formatSize(512 * 1024)).toBe('512 KB');
    expect(formatSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(0)).toBe('0 B');
  });
});

describe('uploadHeaders', () => {
  it('carries the CSRF token once set, and no JSON content type', () => {
    setCsrfToken(null);
    expect(uploadHeaders()).toEqual({});
    setCsrfToken('tok');
    expect(uploadHeaders()).toEqual({ 'x-csrf-token': 'tok' });
    setCsrfToken(null);
  });
});

describe('isPreparer', () => {
  it('allows auditors and audit managers only', () => {
    expect(['auditor', 'audit_manager', 'cae', 'admin', 'viewer'].map((r) => isPreparer(r as never))).toEqual([true, true, false, false, false]);
    expect(isPreparer(undefined)).toBe(false);
  });
});

describe('evidence links', () => {
  const docs = [{ id: 'd1', filename: 'BMR-2026-0142.pdf' }, { id: 'd2', filename: 'notes.txt' }];
  it('labels a link with its filename and page, falling back to the id', () => {
    expect(linkLabel({ documentId: 'd1', page: 7 }, docs)).toBe('BMR-2026-0142.pdf p.7');
    expect(linkLabel({ documentId: 'd2' }, docs)).toBe('notes.txt');
    expect(linkLabel({ documentId: 'gone', page: 2 }, docs)).toBe('gone p.2');
    expect(linkLabel({ documentId: 'gone' }, docs)).toBe('gone');
  });
  it('toggles by document and page', () => {
    const a = { documentId: 'd1', page: 7 };
    const added = toggleLink([], a);
    expect(added).toEqual([a]);
    expect(toggleLink(added, { documentId: 'd1', page: 8 })).toHaveLength(2);
    expect(toggleLink(added, { documentId: 'd1' })).toHaveLength(2);
    expect(toggleLink(added, { documentId: 'd1', page: 7, note: 'x' })).toEqual([]);
    expect(added).toEqual([a]);
  });
  it('merges document lists with the first list winning', () => {
    const m = mergeDocuments([{ id: 'a', n: 1 }, { id: 'b', n: 1 }], [{ id: 'b', n: 2 }, { id: 'c', n: 2 }]);
    expect(m).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 2 }]);
  });
});
