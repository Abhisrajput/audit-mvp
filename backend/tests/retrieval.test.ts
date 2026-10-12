import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { Classification, DocumentKind } from '../src/knowledge/access';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { compilePacks } from '../src/knowledge/graph/compile';
import { loadBundle, loadBundles } from '../src/knowledge/okf/bundle';
import { PgFtsRetriever } from '../src/knowledge/retriever';
import type { AuditService } from '../src/service';
import { admin, approver, auditor, engagementWithFailedControl, newService, registry, reviewer, viewer } from './helpers';
import { demoRoot } from './okf-fixtures';

describe('permission-filtered retrieval', () => {
  let svc: AuditService;
  let engA: string;
  let engB: string;
  const ids: Record<string, string> = {};

  async function add(key: string, classification: Classification, engagementId: string | null, text: string, kind: DocumentKind = 'sop') {
    const d = await insertDocument(svc.db.kysely, {
      sha256: key.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64), filename: `${key}.pdf`, mime: 'application/pdf', size: 10,
      kind, classification, engagementId, uploadedBy: 'auditor',
    });
    await setDocumentText(svc.db.kysely, d, { extractor: 'test', extractorVersion: '1', text, pageStarts: [0] });
    ids[key] = d.id;
  }

  beforeAll(async () => {
    svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    engA = (await engagementWithFailedControl(svc)).id;
    engB = (await engagementWithFailedControl(svc)).id;
    await add('internal', 'internal', null, 'Allergen changeover cleaning must be verified with a swab before restart.');
    await add('confidential', 'confidential', null, 'Allergen matrix for the hazelnut line, supplier confidential.');
    await add('restricted', 'restricted', null, 'Allergen incident investigation, restricted to quality leadership.');
    await add('engA', 'internal', engA, 'Allergen swab log for engagement A, March.', 'evidence');
    await add('engB', 'internal', engB, 'Allergen swab log for engagement B, April.', 'evidence');
    await add('expired', 'internal', null, 'Allergen procedure superseded in 2019.');
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${ids.expired}`.execute(svc.db.kysely);
  });

  const docsFound = async (user: typeof auditor, opts: { engagementId?: string; kinds?: DocumentKind[] } = {}) =>
    (await new PgFtsRetriever(svc.db.kysely).search('allergen', { user, ...opts }))
      .flatMap((h) => (h.kind === 'chunk' ? [h.citation.documentId] : []))
      .sort();

  it('gives each role only the classifications it may read [REQ-23]', async () => {
    expect(await docsFound(viewer)).toEqual([ids.internal].sort());
    expect(await docsFound(auditor)).toEqual([ids.internal, ids.confidential].sort());
    expect(await docsFound(reviewer)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(approver)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(admin)).toEqual([]);
  });

  it('never lets the evidence of one engagement surface in a search of a different engagement [REQ-23]', async () => {
    expect(await docsFound(auditor, { engagementId: engA })).toEqual([ids.internal, ids.confidential, ids.engA].sort());
    expect(await docsFound(auditor, { engagementId: engB })).toEqual([ids.internal, ids.confidential, ids.engB].sort());
    expect(await docsFound(auditor)).not.toContain(ids.engA);
  });

  it('keeps restricted words out of snippets for readers who may not see them [REQ-23]', async () => {
    const hits = await new PgFtsRetriever(svc.db.kysely).search('incident investigation quality leadership', { user: auditor });
    expect(hits).toEqual([]);
  });

  it('skips documents past retention and can filter by kind', async () => {
    expect(await docsFound(reviewer)).not.toContain(ids.expired);
    expect(await docsFound(auditor, { engagementId: engA, kinds: ['evidence'] })).toEqual([ids.engA]);
  });

  it('returns ranked hits with a snippet and a document-and-page citation', async () => {
    const [hit] = await new PgFtsRetriever(svc.db.kysely).search('swab before restart', { user: viewer });
    expect(hit).toMatchObject({
      id: `${ids.internal}:0`, kind: 'chunk', title: 'internal.pdf', citable: true,
      citation: { documentId: ids.internal, filename: 'internal.pdf', page: 1, chunkOrdinal: 0 },
    });
    expect(hit.snippet).toMatch(/swab/i);
    expect(hit.score).toBeGreaterThan(0);
  });

  it('filters on the document row, even when the chunk copy of its scope disagrees with it [REQ-23]', async () => {
    // Chunks written directly (not through setDocumentText) with stale copies of the document's scope.
    const db = svc.db.kysely;
    const secret = await insertDocument(db, { sha256: 'c'.repeat(64), filename: 'stale-secret.pdf', mime: 'application/pdf', size: 1, kind: 'sop', classification: 'restricted', engagementId: null, uploadedBy: 'auditor' });
    const other = await insertDocument(db, { sha256: 'd'.repeat(64), filename: 'stale-eng.pdf', mime: 'application/pdf', size: 1, kind: 'evidence', classification: 'internal', engagementId: engB, uploadedBy: 'auditor' });
    await db.insertInto('chunks').values([
      { id: `${secret.id}:0`, document_id: secret.id, kg_node_id: null, ordinal: 0, page: null, text: 'Quarantine hold release staleness.', classification: 'internal', engagement_id: null },
      { id: `${other.id}:0`, document_id: other.id, kg_node_id: null, ordinal: 0, page: null, text: 'Quarantine hold release staleness.', classification: 'internal', engagement_id: null },
    ]).execute();
    const found = async (user: typeof auditor, engagementId?: string) =>
      (await new PgFtsRetriever(db).search('quarantine staleness', { user, engagementId })).map((h) => h.citation.documentId).sort();
    expect(await found(viewer)).toEqual([]);
    expect(await found(auditor, engA)).toEqual([]);
    expect(await found(auditor, engB)).toEqual([other.id]);
    expect(await found(reviewer)).toEqual([secret.id]);
  });

  it('caps hits at 50 however many chunks match, and answers a stop-word-only query with nothing', async () => {
    const db = svc.db.kysely;
    const d = await insertDocument(db, { sha256: 'e'.repeat(64), filename: 'many.pdf', mime: 'application/pdf', size: 1, kind: 'sop', classification: 'internal', engagementId: null, uploadedBy: 'auditor' });
    const text = Array.from({ length: 60 }, (_, i) => `Zymurgy paragraph ${i}. ${'filler '.repeat(150)}`).join('\n\n');
    expect(await setDocumentText(db, d, { extractor: 'test', extractorVersion: '1', text })).toBeGreaterThanOrEqual(60);
    expect((await new PgFtsRetriever(db).search('zymurgy', { user: viewer, limit: 10_000 })).length).toBe(50);
    expect(await new PgFtsRetriever(db).search('the and of', { user: viewer })).toEqual([]);
  });

  it('returns nothing for an empty query and caps the number of hits', async () => {
    expect(await new PgFtsRetriever(svc.db.kysely).search('   ', { user: reviewer })).toEqual([]);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 2 })).length).toBe(2);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 10_000 })).length).toBeLessThanOrEqual(50);
  });
});

describe('knowledge-graph hits', () => {
  let svc: AuditService;
  const search = (q: string, user: typeof auditor, kinds?: DocumentKind[]) => new PgFtsRetriever(svc.db.kysely).search(q, { user, kinds });

  beforeAll(async () => {
    svc = await newService();
    await compilePacks(svc.db, loadBundles());
  });

  it('finds library concepts with a citation to the bundle file and says they are not yet citable [REQ-22]', async () => {
    const clause = registry.clauses.get('21CFR211.22')!;
    const hits = await search(clause.title, viewer);
    const hit = hits.find((h) => h.kind === 'kg_node' && h.citation.conceptId === '21CFR211.22');
    expect(hit).toMatchObject({
      kind: 'kg_node', citable: false, trustProblems: ['UNVERIFIED_SOURCE'],
      citation: { nodeId: 'pharma/clause/21cfr211-22', packId: 'pharma', packVersion: '0.2.0', sourcePath: 'pharma/clauses/21cfr211-22.md', chunkOrdinal: 0 },
    });
    expect(hit!.title).toBe(`21CFR211.22 — ${clause.title}`);
    expect(await search(clause.title, admin)).toEqual([]);
  });

  it('selects knowledge-graph nodes with the okf_concept kind', async () => {
    const clause = registry.clauses.get('21CFR211.22')!;
    expect((await search(clause.title, auditor, ['sop'])).some((h) => h.kind === 'kg_node')).toBe(false);
    const only = await search(clause.title, auditor, ['okf_concept']);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => h.kind === 'kg_node')).toBe(true);
  });

  it('applies classification to knowledge-graph nodes too [REQ-23]', async () => {
    const restricted = demoRoot((f) => f.set('pack.md', f.get('pack.md')!.replace('classification: internal', 'classification: restricted')));
    await compilePacks(svc.db, [loadBundle(restricted, 'demo')]);
    const demoHits = async (user: typeof auditor) => (await search('records policy', user)).filter((h) => h.kind === 'kg_node' && h.citation.packId === 'demo');
    expect(await demoHits(viewer)).toEqual([]);
    expect(await demoHits(auditor)).toEqual([]);
    expect((await demoHits(reviewer)).length).toBeGreaterThan(0);
  });

  it('marks a verified, current concept citable and never returns deprecated ones [REQ-22]', async () => {
    const own = await newService();
    const v1 = demoRoot((f) => f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('verified: null', 'verified:\n  by: Dr Rao\n  role: QA SME\n  at: 2026-10-01').replace('stale_after: 2027-10-11', 'stale_after: 2999-12-31')));
    await compilePacks(own.db, [loadBundle(v1, 'demo')]);
    const policy = (await new PgFtsRetriever(own.db.kysely).search('records policy', { user: auditor })).find((h) => h.kind === 'kg_node' && h.citation.conceptId === 'DS-1');
    expect(policy).toMatchObject({ citable: true, trustProblems: [] });

    const v2 = demoRoot((f) => {
      f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.3.0'));
      f.delete('clauses/ds-1.md');
      f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace(/  - ref: \/clauses\/ds-1\.md\n/, '').replace(/    - DS-1\n/, ''));
    });
    await compilePacks(own.db, [loadBundle(v2, 'demo')]);
    const after = await new PgFtsRetriever(own.db.kysely).search('records policy exists', { user: auditor });
    expect(after.some((h) => h.kind === 'kg_node' && h.citation.conceptId === 'DS-1')).toBe(false);
  });
});
