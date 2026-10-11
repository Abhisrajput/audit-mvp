import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { createMemoryDb } from '../src/db/pglite';
import { CLASSIFICATIONS_BY_ROLE, mayRead } from '../src/knowledge/access';
import { CHUNK_TARGET_CHARS, chunkText } from '../src/knowledge/chunk';
import { getDocument, insertDocument, listDocuments, setDocumentText, type NewDocument } from '../src/knowledge/document-repo';
import { engagementWithFailedControl, newService } from './helpers';

const para = (n: number, words = 40) => Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(' ');

describe('chunking', () => {
  it('returns nothing for empty text and one chunk for short text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n ')).toEqual([]);
    expect(chunkText('Short SOP text.')).toEqual([{ ordinal: 0, page: null, text: 'Short SOP text.' }]);
  });

  it('keeps paragraphs together and splits near 1,200 characters', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS * 2);
    expect(chunks.map((c) => c.text).join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('splits one very long paragraph at word boundaries', () => {
    const chunks = chunkText(para(1, 1200));
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      expect(c.text).toMatch(/^word1x\d+( word1x\d+)*$/);
    }
  });

  it('labels each chunk with the page it starts on', () => {
    const p1 = para(1);
    const p2 = para(2);
    const text = `${p1}\n\n${p2}`;
    const chunks = chunkText(text, [0, text.indexOf(p2)]);
    expect(chunks.every((c) => c.page !== null)).toBe(true);
    expect(chunkText(`${para(3, 400)}\n\n${para(4, 400)}`, [0, 3000]).map((c) => c.page)).toContain(2);
  });
});

describe('who may read what', () => {
  it('matches the classification table', () => {
    expect(CLASSIFICATIONS_BY_ROLE).toEqual({
      viewer: ['internal'],
      auditor: ['internal', 'confidential'],
      audit_manager: ['internal', 'confidential', 'restricted'],
      cae: ['internal', 'confidential', 'restricted'],
      admin: [],
    });
    expect(mayRead('auditor', 'restricted')).toBe(false);
    expect(mayRead('cae', 'restricted')).toBe(true);
  });
});

describe('document registry', () => {
  const doc = (over: Partial<NewDocument> = {}): NewDocument => ({
    sha256: 'a'.repeat(64), filename: 'SOP-ALG-004.pdf', mime: 'application/pdf', size: 1234, kind: 'sop',
    classification: 'confidential', engagementId: null, uploadedBy: 'auditor', ...over,
  });

  it('registers documents, never deletes them, and stores text as searchable chunks', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;

    const global = await insertDocument(db, doc());
    expect(global).toMatchObject({ id: expect.stringMatching(/^DOC-[0-9a-f]{12}$/), engagementId: null, retentionExpired: false, metadata: {} });
    const evidence = await insertDocument(db, doc({ kind: 'evidence', classification: 'restricted', engagementId: e.id, filename: 'CCP-LOG-MAR.xlsx' }));
    expect(await getDocument(db, evidence.id)).toEqual(evidence);

    const text = `${para(1)}\n\n${para(2)}\n\nAllergen changeover swab not recorded.`;
    expect(await setDocumentText(db, evidence, { extractor: 'test', extractorVersion: '1', text })).toBeGreaterThan(0);
    const chunks = await db.selectFrom('chunks').selectAll().where('document_id', '=', evidence.id).orderBy('ordinal').execute();
    expect(chunks[0]).toMatchObject({ id: `${evidence.id}:0`, classification: 'restricted', engagement_id: e.id, embedding: null });
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from chunks where tsv @@ websearch_to_tsquery('english', 'allergen swab')`.execute(db);
    expect(rows[0].n).toBe(1);

    await expect(setDocumentText(db, evidence, { extractor: 'test', extractorVersion: '1', text })).rejects.toMatchObject({ status: 409 });
    await expect(db.deleteFrom('documents').where('id', '=', global.id).execute()).rejects.toThrow(/append-only: DELETE/);
  });

  it('lists documents within the requested scope and readable classifications', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const a = await insertDocument(db, doc({ classification: 'internal' }));
    await insertDocument(db, doc({ classification: 'restricted' }));
    const c = await insertDocument(db, doc({ engagementId: e.id, classification: 'internal' }));
    expect((await listDocuments(db, { engagementId: null, classifications: ['internal'] })).map((d) => d.id)).toEqual([a.id]);
    expect((await listDocuments(db, { engagementId: e.id, classifications: ['internal'] })).map((d) => d.id)).toEqual([c.id]);
    expect(await listDocuments(db, { engagementId: null, classifications: [] })).toEqual([]);
  });

  it('runs the same migrations on the in-process database used by eval', async () => {
    const mem = await createMemoryDb();
    try {
      const { rows } = await sql<{ ok: boolean }>`select exists(select 1 from pg_extension where extname = 'vector') as ok`.execute(mem.kysely);
      expect(rows[0].ok).toBe(true);
    } finally {
      await mem.close();
    }
  });
});
