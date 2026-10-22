import { sql } from 'kysely';
import { ensureDevUsers } from '../src/auth/dev-users';
import { describe, expect, it } from 'vitest';
import { insertEngagement, loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import type { TestDraft } from '../src/engine/types';
import { documentPageText } from '../src/evidence/text';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { workpaperContentHash } from '../src/signing/content-hash';
import type { WorkpaperKind } from '../src/agents/types';
import { engagement, finding, plan, row, scopeItem } from './agent-fixtures';
import { testDb } from './db';
import { auditor, leasedRun, NEW_ENGAGEMENT, newService } from './helpers';

const draft: TestDraft = {
  rowId: 'R-1',
  proposal: { designAdequate: true, sampleTested: 5, exceptions: 1, observation: 'One late log.' },
  evidence: [{ documentId: 'DOC-1', page: 2, quote: 'late by 3h' }],
  couldNotVerify: ['calibration'],
  confidence: 'medium',
  qa: { blocking: [], advisory: ['thin sample'] },
  draftedBy: { runId: 'RUN-1', at: '2026-10-22T10:00:00.000Z', model: 'm' },
};

describe('test drafts model', () => {
  it('round-trips testDrafts through insert, load and save, and loads {} for a pre-3B engagement', async () => {
    const db = (await testDb()).kysely;
    const e = engagement({ id: 'ENG-D', testDrafts: { 'R-1': draft } });
    await insertEngagement(db, e);
    const a = (await loadEngagement(db, 'ENG-D'))!;
    expect(a.engagement.testDrafts).toEqual({ 'R-1': draft });
    a.engagement.testDrafts['R-2'] = { ...draft, rowId: 'R-2', personEdited: true };
    await saveEngagement(db, a);
    expect((await loadEngagement(db, 'ENG-D'))!.engagement.testDrafts['R-2']).toEqual({ ...draft, rowId: 'R-2', personEdited: true });

    // A row written before the column existed takes the column default.
    await insertEngagement(db, engagement({ id: 'ENG-OLD' }));
    await sql`INSERT INTO engagements (id, name, entity, site, period_from, period_to, audit_type, scope_statement, pack_ids, created_by, created_at, stage, version)
      SELECT 'ENG-RAW', name, entity, site, period_from, period_to, audit_type, scope_statement, pack_ids, created_by, created_at, stage, version FROM engagements WHERE id = 'ENG-OLD'`.execute(db);
    await sql`INSERT INTO engagement_work (engagement_id, scope, rcm, test_inputs, test_results) VALUES ('ENG-RAW', '[]', '[]', '{}', '{}')`.execute(db);
    expect((await loadEngagement(db, 'ENG-RAW'))!.engagement.testDrafts).toEqual({});
  });

  it('a draft write does not change any workpaper content hash or signature state', async () => {
    const memo = { subjectKey: 'x', calls: [], forTheReviewer: ['look'], producedAt: 't' };
    const r = row('R-1');
    const e = engagement({
      id: 'ENG-H', rcm: [r], testPlans: { 'R-1': plan(r) }, scope: [scopeItem('R-1')], findings: [finding('R-1')],
      memos: { scope: { ...memo, subjectKey: 'scope' }, rcm: { ...memo, subjectKey: 'rcm' }, test_plans: { ...memo, subjectKey: 'test_plans' }, report: { ...memo, subjectKey: 'report' } },
      report: { generatedAt: 't', bundleId: 'RUN-1', markdown: '# r', includedFindingIds: ['F-R-1'], excludedFindingIds: [], opinion: { rating: 'satisfactory', basis: 'b', findingsFingerprint: 'f' } },
    });
    const kinds: WorkpaperKind[] = ['scope', 'rcm', 'test_plans', 'report'];
    const before = kinds.map((k) => workpaperContentHash(k, e));
    expect(workpaperContentHash('report', { ...e, report: null })).not.toBe(before[3]);
    const findings = JSON.stringify(e.findings);
    e.testDrafts['R-1'] = draft;
    expect(kinds.map((k) => workpaperContentHash(k, e))).toEqual(before);
    expect(JSON.stringify(e.findings)).toBe(findings);
  });

  it('saving a draft adds no workpaper revision', async () => {
    const svc = await newService();
    const created = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    await svc.runModule(created.id, 'scope', auditor);
    const scope = (await svc.engagement(created.id)).scope;
    await svc.setScope(created.id, scope.map((s, i) => ({ controlId: s.controlId, included: i < 2 })), auditor);
    await svc.runModule(created.id, 'rcm', auditor);
    const e = await svc.engagement(created.id);
    const revisions = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM workpaper_revisions`.execute(svc.db.kysely)).rows[0].n);
    const count = await revisions();
    const { acting } = await leasedRun(svc, created.id);
    await svc.saveTestDraftsAsAgent(created.id, { [e.rcm[0].id]: { ...draft, rowId: e.rcm[0].id } }, acting('test-draft'), { expectedVersion: e.version! });
    expect((await svc.engagement(created.id)).testDrafts[e.rcm[0].id]).toBeDefined();
    expect(await revisions()).toBe(count);
  });

  it('documentPageText slices pages 1-based and answers null without text and 400 out of range', async () => {
    const db = (await testDb()).kysely;
    await ensureDevUsers(db);
    const doc = await insertDocument(db, { sha256: 'a'.repeat(64), filename: 'f.pdf', mime: 'application/pdf', size: 9, kind: 'evidence', classification: 'internal', engagementId: null, uploadedBy: 'auditor' });
    expect(await documentPageText(db, doc.id)).toBeNull();
    await setDocumentText(db, doc, { extractor: 'x', extractorVersion: '1', text: 'AAA|BBB|CC', pageStarts: [0, 4, 8] });
    expect(await documentPageText(db, doc.id)).toEqual({ page: null, pages: 3, text: 'AAA|BBB|CC' });
    expect(await documentPageText(db, doc.id, 1)).toEqual({ page: 1, pages: 3, text: 'AAA|' });
    expect(await documentPageText(db, doc.id, 3)).toEqual({ page: 3, pages: 3, text: 'CC' });
    await expect(documentPageText(db, doc.id, 4)).rejects.toMatchObject({ status: 400 });
    await expect(documentPageText(db, doc.id, 0)).rejects.toMatchObject({ status: 400 });
  });
});
