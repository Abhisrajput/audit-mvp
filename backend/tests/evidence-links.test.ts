import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { createApp } from '../src/app';
import { ModuleContext } from '../src/engine/module';
import { reportModule } from '../src/engine/modules/report';
import { testEvidenceGate } from '../src/engine/qa';
import type { EvidenceLink } from '../src/engine/types';
import { changedLinks, documentNamesFor, documentUsage, hasEvidence, linkedDocumentIds, normaliseEvidence } from '../src/evidence/links';
import { insertExtraction } from '../src/evidence/extraction-repo';
import { insertDocument } from '../src/knowledge/document-repo';
import { findingContentHash } from '../src/signing/content-hash';
import { auditor, engagementWithFailedControl, NEW_ENGAGEMENT, newService, reviewer, LENIENT } from './helpers';
import { devAuthConfig, signIn } from './http';
import { FIXED_FINDING } from './fixtures/fixed-finding';

const INPUT = { designAdequate: true, observation: 'All 20 CCP logs were signed and reviewed.', sampleTested: 20, exceptions: 0 }
const FAILING = { observation: '3 of 20 CCP logs unsigned.', exceptions: 3 };
const ROW = 'FD-HACCP-03';
const PRE_3A_HASH = 'ee5a15d4f3d790d33edfbb7eb28096944f39340368a900972991310d0163fe54';

async function setup() {
  const svc = await newService();
  const db = svc.db.kysely;
  await ensureDevUsers(db);
  const e = await engagementWithFailedControl(svc);
  const other = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  const doc = (over: { engagementId?: string | null; classification?: 'internal' | 'confidential' | 'restricted'; filename?: string; pages?: number | null | false } = {}) =>
    insertDocument(db, { sha256: 'a'.repeat(64), filename: over.filename ?? 'log.pdf', mime: 'application/pdf', size: 10, kind: 'evidence', classification: over.classification ?? 'internal', engagementId: over.engagementId === undefined ? e.id : over.engagementId, uploadedBy: 'auditor' })
      .then(async (d) => {
        if (over.pages !== false) await insertExtraction(db, { documentId: d.id, extractor: 'pdf', extractorVersion: '1', status: 'ok', chars: 10, pages: over.pages === undefined ? 3 : over.pages, error: null, by: 'auditor' });
        return d;
      });
  const record = (evidence: EvidenceLink[] | undefined, who = auditor, evidenceRefs: string[] = [], over: Partial<typeof INPUT> = {}) =>
    svc.recordTest(e.id, ROW, { ...INPUT, ...over, evidenceRefs, ...(evidence ? { evidence } : {}) }, who);
  return { svc, db, e, other, doc, record };
}

const failure = async (p: Promise<unknown>) => p.then(() => null, (err) => err as { status: number; code: string; message: string });

describe('evidence links', () => {
  it('records a test with links to a readable document on the engagement and to a global one [REQ-39]', async () => {
    const { svc, e, doc, record } = await setup();
    const mine = await doc();
    const global = await doc({ engagementId: null });
    await record([{ documentId: mine.id, page: 2, note: '  signed log ' }, { documentId: global.id }, { documentId: mine.id, page: 2 }]);
    const saved = (await svc.engagement(e.id)).testInputs[ROW];
    expect(saved.evidence).toEqual([{ documentId: mine.id, page: 2, note: 'signed log' }, { documentId: global.id }]);
    expect(JSON.stringify((await readTrail(svc.db.kysely)).at(-1))).toContain(global.id);
  });

  it('a link to another engagement\'s document is refused like a missing one [REQ-39]', async () => {
    const { other, doc, record } = await setup();
    const elsewhere = await doc({ engagementId: other.id });
    const a = await failure(record([{ documentId: elsewhere.id }]));
    const b = await failure(record([{ documentId: 'DOC-missing' }]));
    expect(a).toMatchObject({ status: 400, code: 'EVIDENCE_NOT_FOUND' });
    expect(b).toMatchObject({ status: 400, code: 'EVIDENCE_NOT_FOUND' });
    expect(a!.message.replace(elsewhere.id, '<id>')).toBe(b!.message.replace('DOC-missing', '<id>'));
  });

  it('a restricted document is refused for an auditor and accepted for an audit manager [REQ-39]', async () => {
    const { svc, e, doc, record } = await setup();
    const secret = await doc({ classification: 'restricted' });
    const missing = await failure(record([{ documentId: 'DOC-nope' }]));
    const refused = await failure(record([{ documentId: secret.id }]));
    expect(refused).toMatchObject({ status: 400, code: 'EVIDENCE_NOT_FOUND' });
    expect(refused!.message.replace(secret.id, '<id>')).toBe(missing!.message.replace('DOC-nope', '<id>'));
    await record([{ documentId: secret.id }], reviewer);
    expect((await svc.engagement(e.id)).testInputs[ROW].evidence).toEqual([{ documentId: secret.id }]);
  });

  it('an expired document cannot be newly linked, but re-saving a record whose linked document has since expired is allowed [REQ-39]', async () => {
    const { svc, e, db, doc, record } = await setup();
    const d = await doc();
    const fresh = await doc();
    await record([{ documentId: d.id }]);
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${d.id}`.execute(db);
    await record([{ documentId: d.id }]); // untouched link
    await svc.recordTest(e.id, ROW, { ...INPUT, observation: 'edited', evidenceRefs: [], evidence: [{ documentId: d.id }] }, auditor);
    expect(await failure(record([{ documentId: d.id }, { documentId: d.id, page: 1 }]))).toMatchObject({ status: 400, code: 'EVIDENCE_EXPIRED' });
    await record([{ documentId: d.id }, { documentId: fresh.id }]);
  });

  it('a page beyond the extracted page count is refused; a page on a document without pages is accepted', async () => {
    const { svc, e, doc, record } = await setup();
    const three = await doc({ pages: 3 });
    const unknown = await doc({ pages: null });
    const never = await doc({ pages: false });
    expect(await failure(record([{ documentId: three.id, page: 4 }]))).toMatchObject({ status: 400, code: 'VALIDATION' });
    await record([{ documentId: three.id, page: 3 }, { documentId: unknown.id, page: 40 }, { documentId: never.id, page: 9 }]);
    expect((await svc.engagement(e.id)).testInputs[ROW].evidence).toHaveLength(3);
  });

  it('Effective with a link and no refs passes the evidence gate; with neither it is downgraded [REQ-05, REQ-39]', async () => {
    const { svc, e } = await setup();
    const row = e.rcm.find((r) => r.id === ROW)!;
    const base = { rowId: ROW, conclusion: 'Effective' as const, rationale: 'r', exceptionRate: 0, qaFlags: [] };
    const input = { ...INPUT, sampleTested: row.sampleSize, evidenceRefs: [] as string[], updatedBy: 'a', updatedAt: 't' };
    const withLink = testEvidenceGate(row, { ...input, evidence: [{ documentId: 'DOC-1' }] }, base);
    expect(withLink.result.conclusion).toBe('Effective');
    expect(withLink.actions[0]).toMatchObject({ outcome: 'pass' });
    expect(withLink.actions[0].detail).toContain('Effective');
    const neither = testEvidenceGate(row, input, base);
    expect(neither.result.conclusion).toBe('Not tested');
    expect(hasEvidence({ evidenceRefs: [], evidence: [{ documentId: 'x' }] })).toBe(true);
    expect(hasEvidence({ evidenceRefs: ['r'] })).toBe(true);
    expect(hasEvidence({ evidenceRefs: [], evidence: [] })).toBe(false);
    void svc;
  });

  it('the finding drafted from a linked test carries the links, prints them in the report and exports them', async () => {
    const { svc, e, doc, record } = await setup();
    const d = await doc({ filename: 'ccp-march.pdf' });
    const unnamed = await doc();
    await record([{ documentId: d.id, page: 2 }, { documentId: unnamed.id }], auditor, ['CCP-LOG-MAR'], FAILING);
    await svc.runModule(e.id, 'testing', auditor);
    await svc.runModule(e.id, 'gaps', auditor);
    const live = await svc.engagement(e.id);
    const f = live.findings.find((x) => x.rowId === ROW)!;
    expect(f.evidence).toEqual([{ documentId: d.id, page: 2 }, { documentId: unnamed.id }]);
    const csv = await svc.findingsCsv(e.id);
    expect(csv).toContain(`${d.id} p.2; ${unnamed.id}; CCP-LOG-MAR`);
    expect(csv.split('\n')[0]).toBe('id,status,rating,controlId,title,condition,criteria,cause,effect,recommendation,citations,evidenceRefs,signatures,signature_issues,bundleId');
    const approved = structuredClone(live);
    approved.findings.forEach((x) => { x.status = 'approved'; });
    const ctx = new ModuleContext(approved, svc.registry, svc.grounding, null, auditor, {}, LENIENT.citationPolicy, new Map([[d.id, { filename: 'ccp-march.pdf' }]]));
    const out = await reportModule.run(ctx);
    expect(out.markdown).toContain(`_Evidence:_ ccp-march.pdf (p. 2), ${unnamed.id}, CCP-LOG-MAR`);
  });

  it('editing a finding validates new links, trails the change, and an empty list removes them [REQ-39]', async () => {
    const { svc, e, doc } = await setup();
    const d = await doc({ filename: 'x.pdf' });
    const f = (await svc.engagement(e.id)).findings[0];
    expect(await failure(svc.editFinding(e.id, f.id, { evidence: [{ documentId: 'DOC-nope' }] }, auditor))).toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });
    const edited = await svc.editFinding(e.id, f.id, { evidence: [{ documentId: d.id }, { documentId: d.id }] }, auditor);
    expect(edited.evidence).toEqual([{ documentId: d.id }]);
    const removed = await svc.editFinding(e.id, f.id, { evidence: [] }, auditor);
    expect('evidence' in removed).toBe(false);
    expect(JSON.stringify(removed)).not.toContain('"evidence":');
  });

  it('a finding without evidence hashes as before 3A [REQ-39]', () => {
    expect(findingContentHash(FIXED_FINDING)).toBe(PRE_3A_HASH);
  });

  it('a finding with evidence hashes differently and an empty array is normalised to absent [REQ-39]', async () => {
    const withLink = { ...FIXED_FINDING, evidence: [{ documentId: 'DOC-1', page: 2 }] };
    expect(findingContentHash(withLink)).not.toBe(PRE_3A_HASH);
    expect(findingContentHash(withLink)).toBe(WITH_EVIDENCE_HASH);
    expect(normaliseEvidence([])).toBeUndefined();
    expect(normaliseEvidence(undefined)).toBeUndefined();
    expect(changedLinks([{ documentId: 'a', page: 1 }], [{ documentId: 'a', page: 1, note: 'x' }, { documentId: 'a' }])).toEqual([{ documentId: 'a' }]);
    const { svc, e, record } = await setup();
    await record([]);
    expect('evidence' in (await svc.engagement(e.id)).testInputs[ROW]).toBe(false);
    const stored = await svc.db.kysely.selectFrom('engagement_work').select('test_inputs').where('engagement_id', '=', e.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.test_inputs)).not.toContain('"evidence"');
  });

  it('usage lists the tests and findings that cite a document, within what the caller may list', async () => {
    const { svc, e, doc, record } = await setup();
    const d = await doc();
    const secret = await doc({ classification: 'restricted' });
    await record([{ documentId: d.id }], auditor, ['x'], FAILING);
    await svc.runModule(e.id, 'testing', auditor);
    await svc.runModule(e.id, 'gaps', auditor);
    const finding = (await svc.engagement(e.id)).findings.find((f) => f.rowId === ROW)!;
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'))), maxUploadBytes: 1024, presignDownloads: false });
    const a = await signIn(app, 'auditor');
    const res = await a.get(`/api/documents/${d.id}/usage`).expect(200);
    expect(res.body).toEqual({ tests: [{ engagementId: e.id, rowId: ROW }], findings: [{ engagementId: e.id, findingId: finding.id }] });
    expect((await a.get(`/api/documents/${secret.id}/usage`)).status).toBe(404);
    expect((await a.get('/api/documents/DOC-none/usage')).status).toBe(404);
    expect((await (await signIn(app, 'reviewer')).get(`/api/documents/${secret.id}/usage`)).body).toEqual({ tests: [], findings: [] });
    expect(await linkedDocumentIds(svc.db.kysely)).toEqual(new Set([d.id]));
  });

  it('both golden agent traces are byte-identical', async () => {
    const { runAgentTraces } = await import('../src/eval/agent-traces');
    const { registry } = await import('./helpers');
    const results = await runAgentTraces(registry);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results).toHaveLength(2);
  }, 300_000);
});

describe('evidence links, review round 1', () => {
  it('bounds the schema: 51 links and a 65-character id are 400, and a malformed short id passes the schema [REQ-39]', async () => {
    const { svc, e, doc } = await setup();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'))), maxUploadBytes: 1024, presignDownloads: false });
    const a = await signIn(app, 'auditor');
    const body = (evidence: unknown[]) => ({ ...INPUT, evidenceRefs: [], evidence });
    const many = Array.from({ length: 51 }, (_, i) => ({ documentId: `DOC-${i}` }));
    expect((await a.put(`/api/engagements/${e.id}/tests/${ROW}`, body(many))).status).toBe(400);
    expect((await a.put(`/api/engagements/${e.id}/tests/${ROW}`, body([{ documentId: 'D'.repeat(65) }]))).status).toBe(400);
    const odd = await a.put(`/api/engagements/${e.id}/tests/${ROW}`, body([{ documentId: 'not-a-doc-id' }]));
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe('EVIDENCE_NOT_FOUND');
    const f = (await svc.engagement(e.id)).findings[0];
    expect((await a.put(`/api/engagements/${e.id}/findings/${f.id}`, { evidence: many })).status).toBe(400);
    void doc;
  });

  it('the report prints a restricted document\'s filename for any reader, because the citing person chose the disclosure [REQ-39]', async () => {
    const { svc, e, doc } = await setup();
    const secret = await doc({ classification: 'restricted', filename: 'board-minutes.pdf' });
    const f = (await svc.engagement(e.id)).findings[0];
    await svc.editFinding(e.id, f.id, { evidence: [{ documentId: secret.id, page: 1 }] }, reviewer);
    const live = await svc.engagement(e.id);
    live.findings.forEach((x) => { x.status = 'approved'; });
    const viewer = { id: 'viewer', name: 'Vera Viewer', role: 'viewer' } as never;
    const names = await documentNamesFor(svc.db.kysely, [secret.id]);
    const out = await reportModule.run(new ModuleContext(live, svc.registry, svc.grounding, null, viewer, {}, LENIENT.citationPolicy, names));
    expect(out.markdown).toContain('board-minutes.pdf (p. 1)');
  });

  it('linkedDocumentIds counts a superseded finding version; usage does not [REQ-39]', async () => {
    const { svc, db, e, doc } = await setup();
    const d = await doc();
    const f = (await svc.engagement(e.id)).findings[0];
    await svc.editFinding(e.id, f.id, { evidence: [{ documentId: d.id }] }, auditor);
    await sql`UPDATE findings SET superseded_at = now() WHERE engagement_id = ${e.id} AND id = ${f.id}`.execute(db);
    expect((await linkedDocumentIds(db)).has(d.id)).toBe(true);
    expect(await documentUsage(db, d.id)).toEqual({ tests: [], findings: [] });
  });

  it('a note-only change to an existing link is saved without re-validation, even after the document expired [REQ-39]', async () => {
    const { svc, e, db, doc, record } = await setup();
    const d = await doc();
    await record([{ documentId: d.id, page: 1 }]);
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${d.id}`.execute(db);
    await record([{ documentId: d.id, page: 1, note: 'see stamp' }]);
    expect((await svc.engagement(e.id)).testInputs[ROW].evidence).toEqual([{ documentId: d.id, page: 1, note: 'see stamp' }]);
  });

  it('the test-record trail entry omits evidence when [] is sent and includes it when links are present [REQ-39]', async () => {
    const { db, doc, record } = await setup();
    const d = await doc();
    await record([]);
    const without = JSON.stringify((await readTrail(db)).at(-1));
    expect(without).toContain('human:test-record');
    expect(without).not.toContain('"evidence"');
    await record([{ documentId: d.id }]);
    expect(JSON.stringify((await readTrail(db)).at(-1))).toContain(`"evidence":[{"documentId":"${d.id}"}]`);
  });
});

const WITH_EVIDENCE_HASH = 'f1d2b256f20cf74a6d55eeb9ccecf723fbf015750d2027fcb1cc51c3582e58d5';
