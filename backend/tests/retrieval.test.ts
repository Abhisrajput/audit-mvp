import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { Classification, DocumentKind } from '../src/knowledge/access';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { PgFtsRetriever } from '../src/knowledge/retriever';
import type { AuditService } from '../src/service';
import { admin, approver, auditor, engagementWithFailedControl, newService, reviewer, viewer } from './helpers';

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
    (await new PgFtsRetriever(svc.db.kysely).search('allergen', { user, ...opts })).map((h) => h.citation.documentId).sort();

  it('gives each role only the classifications it may read [REQ-23]', async () => {
    expect(await docsFound(viewer)).toEqual([ids.internal].sort());
    expect(await docsFound(auditor)).toEqual([ids.internal, ids.confidential].sort());
    expect(await docsFound(reviewer)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(approver)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(admin)).toEqual([]);
  });

  it("never lets one engagement's evidence surface in another engagement's search [REQ-23]", async () => {
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

  it('returns nothing for an empty query and caps the number of hits', async () => {
    expect(await new PgFtsRetriever(svc.db.kysely).search('   ', { user: reviewer })).toEqual([]);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 2 })).length).toBe(2);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 10_000 })).length).toBeLessThanOrEqual(50);
  });
});
