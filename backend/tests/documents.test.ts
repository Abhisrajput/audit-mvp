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

  it('splits over-long paragraphs on any whitespace and never exceeds 1,200 characters', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line${i} value`).join('\n');
    const tabs = Array.from({ length: 400 }, (_, i) => `cell${i}`).join('\t');
    const mixed = `${para(1, 30)}\n\n${lines}\n\n${tabs}\n\n${para(2, 500)}`;
    const chunks = chunkText(mixed);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      expect(c.text).not.toMatch(/^\s|\s$/);
    }
    // No word is cut in two: every token in the output is a whole token from the input.
    const tokens = new Set(mixed.split(/\s+/));
    for (const c of chunks) for (const t of c.text.split(/\s+/)) expect(tokens.has(t)).toBe(true);
    for (const text of [para(1, 1200), Array.from({ length: 30 }, (_, i) => para(i, 30 + i * 7)).join('\n\n')]) {
      for (const c of chunkText(text)) expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
  });

  it('accepts page offsets in any order and ignores invalid ones', () => {
    const p1 = para(1, 200);
    const p2 = para(2, 200);
    const text = `${p1}\n\n${p2}`;
    const start2 = text.indexOf(p2);
    const sorted = chunkText(text, [0, start2]).map((c) => c.page);
    expect(chunkText(text, [start2, 0]).map((c) => c.page)).toEqual(sorted);
    expect(chunkText(text, [start2, 0, -5, Number.NaN, 1.5, start2]).map((c) => c.page)).toEqual(sorted);
    expect(sorted).toContain(2);
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

  it('lists global documents plus those of the requested engagement, within readable classifications [REQ-23]', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const a = await insertDocument(db, doc({ classification: 'internal' }));
    await insertDocument(db, doc({ classification: 'restricted' }));
    const c = await insertDocument(db, doc({ engagementId: e.id, classification: 'internal' }));
    expect((await listDocuments(db, { engagementId: null, classifications: ['internal'] })).map((d) => d.id)).toEqual([a.id]);
    expect((await listDocuments(db, { engagementId: e.id, classifications: ['internal'] })).map((d) => d.id)).toEqual([a.id, c.id]);
    expect(await listDocuments(db, { engagementId: null, classifications: [] })).toEqual([]);
  });

  it('returns retain_until as the stored calendar date, whatever the server time zone', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const mem = await createMemoryDb();
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo'; // east of UTC: local midnight is the previous day in UTC
    try {
      await ensureDevUsers(mem.kysely);
      for (const db of [svc.db.kysely, mem.kysely]) {
        const d = await insertDocument(db, doc({ retainUntil: '2030-06-15' }));
        expect(d.retainUntil).toBe('2030-06-15');
        expect((await getDocument(db, d.id))!.retainUntil).toBe('2030-06-15');
        expect((await listDocuments(db, { engagementId: null, classifications: ['confidential'] }))[0].retainUntil).toBe('2030-06-15');
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      await mem.close();
    }
  });

  it("indexes chunks with the document row's classification and engagement, not the caller's copy", async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const real = await insertDocument(db, doc({ classification: 'restricted', engagementId: e.id }));
    await setDocumentText(db, { ...real, classification: 'internal', engagementId: null }, { extractor: 'test', extractorVersion: '1', text: 'Restricted words.' });
    expect(await db.selectFrom('chunks').select(['classification', 'engagement_id']).where('document_id', '=', real.id).execute()).toEqual([
      { classification: 'restricted', engagement_id: e.id },
    ]);
  });

  it('stores a document\'s text once even when two requests race (409 for the loser)', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const db = svc.db.kysely;
    const d = await insertDocument(db, doc());
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => setDocumentText(db, d, { extractor: 'test', extractorVersion: '1', text: `${para(1)}\n\n${para(2)}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect((await db.selectFrom('document_text').select('document_id').execute()).length).toBe(1);
  });

  it('keeps documents, their text, chunks and upload records immutable [REQ-23]', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const db = svc.db.kysely;
    const d = await insertDocument(db, doc());
    await setDocumentText(db, d, { extractor: 'test', extractorVersion: '1', text: 'Some text.' });
    await db.insertInto('blob_uploads').values({ sha256: d.sha256, uploaded_by: 'auditor' }).execute();

    // documents: only the retention flag may change.
    await db.updateTable('documents').set({ retention_expired: true }).where('id', '=', d.id).execute();
    expect((await getDocument(db, d.id))!.retentionExpired).toBe(true);
    for (const change of [{ classification: 'internal' }, { engagement_id: null, filename: 'renamed.pdf' }, { sha256: 'b'.repeat(64) }, { metadata: '{"a":1}' }] as const) {
      await expect(db.updateTable('documents').set(change as never).where('id', '=', d.id).execute()).rejects.toThrow(/append-only: UPDATE/);
    }
    await expect(sql`UPDATE documents SET retain_until = '2040-01-01' WHERE id = ${d.id}`.execute(db)).rejects.toThrow(/append-only: UPDATE/);

    await expect(db.updateTable('document_text').set({ text: 'rewritten' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('document_text').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(db.updateTable('chunks').set({ classification: 'internal' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('chunks').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(db.updateTable('blob_uploads').set({ uploaded_by: 'reviewer' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('blob_uploads').execute()).rejects.toThrow(/append-only: DELETE/);
    for (const table of ['documents', 'document_text', 'chunks', 'blob_uploads']) {
      await expect(sql`TRUNCATE ${sql.table(table)} CASCADE`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
    }

    // Knowledge-graph chunks are not document chunks: compile rewrites them (plan 1E).
    await db.insertInto('kg_nodes').values({
      id: 'p/clause/kg-1', type: 'clause', pack_id: 'p', pack_version: '0.2.0', concept_id: 'KG-1', title: 'T',
      description: null, body: '', tags: '[]', attrs: '{}', generated: null, verified_by: null, verified_role: null,
      verified_at: null, status: 'active', stale_after: null, source_path: 'p/clauses/kg-1.md',
      source_sha256: 'c'.repeat(64), classification: 'internal',
    }).execute();
    await db.insertInto('chunks').values({ id: 'KG:p/clause/kg-1:0', document_id: null, kg_node_id: 'p/clause/kg-1', ordinal: 0, page: null, text: 'node', classification: 'internal', engagement_id: null }).execute();
    await db.updateTable('chunks').set({ text: 'node v2' }).where('id', '=', 'KG:p/clause/kg-1:0').execute();
    await db.deleteFrom('chunks').where('id', '=', 'KG:p/clause/kg-1:0').execute();
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
