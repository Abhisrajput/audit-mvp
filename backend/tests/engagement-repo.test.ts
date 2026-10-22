import { describe, expect, it } from 'vitest';
import { insertEngagement, listEngagements, loadEngagement, saveEngagement } from '../src/db/engagement-repo';
import { latestEvalRun, listEvalRuns, saveEvalRun } from '../src/db/eval-repo';
import type { EvalReport } from '../src/eval/harness';
import type { Engagement, Finding } from '../src/engine/types';
import { testDb } from './db';

const finding = (id: string, status: Finding['status'] = 'draft'): Finding => ({
  id, rowId: 'FD-HACCP-03', controlId: 'FD-HACCP-03', title: `Finding ${id}`, rating: 'High', condition: 'c', criteria: '§117.145',
  cause: 'c', effect: 'e', recommendation: 'r', citations: [{ clauseId: '21CFR117.145', regulation: '21 CFR Part 117', ref: '§117.145', label: '§117.145' }],
  evidenceRefs: ['CCP-LOG'], status, blockedReasons: [], signOffs: [], bundleId: 'RUN-1',
});

const engagement = (id = 'ENG-1'): Engagement => ({
  id, name: 'Test', entity: 'Demo', site: 'Plant', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'Food safety',
  scopeStatement: 'HACCP', packIds: ['food', 'common'], createdBy: 'auditor', createdAt: '2026-10-11T08:00:00.123Z',
  stage: 'findings', scope: [], rcm: [], testInputs: {}, testResults: {}, testPlans: {}, findings: [finding('F-1'), finding('F-2', 'approved')], report: null, context: null, coverage: null, memos: {}, testDrafts: {}, tolerances: {}, responses: {},
});

describe('engagement repository', () => {
  it('round-trips an engagement exactly, in finding order', async () => {
    const db = (await testDb()).kysely;
    const e = engagement();
    await insertEngagement(db, e);
    const loaded = (await loadEngagement(db, 'ENG-1'))!;
    expect(loaded.version).toBe(1);
    expect(loaded.engagement).toEqual({ ...e, version: 1 });
    expect(await loadEngagement(db, 'NOPE')).toBeNull();
  });

  it('lets a new finding reuse the id of a superseded one, keeping the old row', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const a = (await loadEngagement(db, 'ENG-1'))!;
    a.engagement.findings = a.engagement.findings.filter((f) => f.id !== 'F-1');
    await saveEngagement(db, a);
    const b = (await loadEngagement(db, 'ENG-1'))!;
    b.engagement.findings.push({ ...finding('F-1'), title: 'Reborn' });
    await saveEngagement(db, b);
    const c = (await loadEngagement(db, 'ENG-1'))!;
    expect(c.engagement.findings.map((f) => f.title)).toContain('Reborn');
    const rows = await db.selectFrom('findings').select(['superseded_at']).where('id', '=', 'F-1').execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
    // a further edit touches only the live row
    c.engagement.findings.find((f) => f.id === 'F-1')!.title = 'Edited';
    await saveEngagement(db, c);
    const live = await db.selectFrom('findings').select('data').where('id', '=', 'F-1').where('superseded_at', 'is', null).executeTakeFirstOrThrow();
    expect(live.data.title).toBe('Edited');
  });

  it('rejects a save from a stale copy instead of overwriting [REQ-21]', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const a = (await loadEngagement(db, 'ENG-1'))!;
    const b = (await loadEngagement(db, 'ENG-1'))!;
    a.engagement.stage = 'reporting';
    await saveEngagement(db, a);
    expect(a.engagement.version).toBe(2);
    b.engagement.stage = 'rcm';
    await expect(saveEngagement(db, b)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect((await loadEngagement(db, 'ENG-1'))!.engagement.stage).toBe('reporting');
  });

  it('writes only changed findings, supersedes dropped drafts and never touches approved rows', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const approvedBefore = await db.selectFrom('findings').selectAll().where('id', '=', 'F-2').executeTakeFirstOrThrow();

    const l = (await loadEngagement(db, 'ENG-1'))!;
    // Same shape as a Gap Writer re-run: approved finding kept as-is, draft replaced by a new one.
    l.engagement.findings = [l.engagement.findings[1], finding('F-3')];
    await saveEngagement(db, l);

    const after = (await loadEngagement(db, 'ENG-1'))!;
    expect(after.engagement.findings.map((f) => f.id)).toEqual(['F-2', 'F-3']);
    const approvedAfter = await db.selectFrom('findings').selectAll().where('id', '=', 'F-2').executeTakeFirstOrThrow();
    expect(approvedAfter).toEqual(approvedBefore);
    const dropped = await db.selectFrom('findings').select('superseded_at').where('id', '=', 'F-1').executeTakeFirstOrThrow();
    expect(dropped.superseded_at).not.toBeNull();
  });

  it('treats a re-ordered but identical finding object as unchanged', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement());
    const l = (await loadEngagement(db, 'ENG-1'))!;
    const approved = l.engagement.findings[1];
    l.engagement.findings[1] = Object.fromEntries(Object.entries(approved).reverse()) as Finding;
    await expect(saveEngagement(db, l)).resolves.toBeUndefined();
  });

  it('lists engagement summaries with live finding counts', async () => {
    const db = (await testDb()).kysely;
    await insertEngagement(db, engagement('ENG-1'));
    await insertEngagement(db, { ...engagement('ENG-2'), createdAt: '2026-10-12T08:00:00.000Z', findings: [] });
    const list = await listEngagements(db);
    expect(list.map((s) => [s.id, s.findings, s.rcm, s.version])).toEqual([['ENG-1', 2, 0, 1], ['ENG-2', 0, 0, 1]]);
    expect(list[0]).toMatchObject({ auditType: 'Food safety', packIds: ['food', 'common'], createdAt: '2026-10-11T08:00:00.123Z' });
  });
});

describe('eval run repository', () => {
  it('stores runs and lists them newest first without case detail', async () => {
    const db = (await testDb()).kysely;
    const run = (id: string, at: string): EvalReport => ({
      id, at, provider: { id: 'offline', model: 'rules' }, engineVersion: '0.1.0', packVersions: {}, total: 1, passed: 1, byKind: {}, cases: [],
    });
    await saveEvalRun(db, run('EVAL-1', '2026-10-11T00:00:00.000Z'));
    await saveEvalRun(db, run('EVAL-2', '2026-10-12T00:00:00.000Z'));
    expect((await listEvalRuns(db)).map((r) => r.id)).toEqual(['EVAL-2', 'EVAL-1']);
    expect('cases' in (await listEvalRuns(db))[0]).toBe(false);
    expect((await latestEvalRun(db))?.id).toBe('EVAL-2');
  });
});
