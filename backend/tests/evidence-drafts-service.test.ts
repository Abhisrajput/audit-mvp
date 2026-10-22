import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { agentPort } from '../src/agents/port';
import { readTrail } from '../src/db/trail-repo';
import type { TestDraft } from '../src/engine/types';
import { insertDocument } from '../src/knowledge/document-repo';
import type { AuditService } from '../src/service';
import { devAuthConfig, signIn } from './http';
import { auditor, leasedRun, NEW_ENGAGEMENT, newService, viewer } from './helpers';

const A = 'FD-HACCP-03';
const INPUT = { designAdequate: true, observation: 'Reviewed.', evidenceRefs: [] as string[], sampleTested: 5, exceptions: 1 };

const draftFor = (rowId: string, over: Partial<TestDraft> = {}): TestDraft => ({
  rowId,
  proposal: { designAdequate: true, sampleTested: 5, exceptions: 1, observation: 'One late log.' },
  evidence: [{ documentId: 'DOC-X', page: 1, quote: 'late by 3h' }],
  couldNotVerify: ['calibration'], confidence: 'medium', qa: { blocking: ['thin'], advisory: [] },
  draftedBy: { runId: 'RUN-X', at: '2026-10-22T10:00:00.000Z', model: 'm' }, ...over,
});

async function setup() {
  const svc = await newService();
  const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
  await svc.runModule(e.id, 'scope', auditor);
  const scope = (await svc.engagement(e.id)).scope;
  const [a, b] = scope.slice(0, 2).map((s) => s.controlId);
  await svc.setScope(e.id, scope.map((s) => ({ controlId: s.controlId, included: s.controlId === a || s.controlId === b })), auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  const rows = (await svc.engagement(e.id)).rcm.map((r) => r.id);
  const { run, acting } = await leasedRun(svc, e.id);
  const port = agentPort(svc);
  const save = async (drafts: Record<string, TestDraft>) =>
    port.saveTestDrafts(e.id, drafts, acting('test-draft'), { expectedVersion: (await svc.engagement(e.id)).version! });
  return { svc, e, rows, run, acting, port, save };
}
const failure = async (p: Promise<unknown>) => p.then(() => null, (err) => err as { status: number; code: string; message: string });

describe('test drafts: agent write, accept and discard', () => {
  it('the agent may write a draft for an untested row and may not touch a tested row or a person-edited draft [REQ-41]', async () => {
    const { svc, e, rows, save } = await setup();
    const [r1, r2] = rows;
    const { bundle } = await save({ [r1]: draftFor(r1) });
    expect((await svc.engagement(e.id)).testDrafts[r1].qa.blocking).toEqual(['thin']);
    expect(bundle.moduleId).toBe('agent:test-drafts');
    expect(bundle.inputs).toMatchObject({ rows: [r1] });
    expect(bundle.output).toEqual({ drafts: [{ rowId: r1, proposal: true, quotes: 1, blocking: ['thin'] }] });
    // another row's draft is left alone
    await save({ [r2]: draftFor(r2) });
    expect(Object.keys((await svc.engagement(e.id)).testDrafts).sort()).toEqual([r1, r2].sort());
    // replacing an agent draft is fine
    await save({ [r1]: draftFor(r1, { confidence: 'high' }) });
    expect((await svc.engagement(e.id)).testDrafts[r1].confidence).toBe('high');
    // a tested row is refused
    await svc.recordTest(e.id, r2, INPUT, auditor);
    expect(await failure(save({ [r2]: draftFor(r2, { confidence: 'low' }) }))).toMatchObject({ status: 403, code: 'AGENT_FORBIDDEN' });
    // a person-edited draft is refused
    await svc.discardTestDraft(e.id, r1, auditor);
    expect(await failure(save({ [r1]: draftFor(r1) }))).toMatchObject({ status: 403, code: 'AGENT_FORBIDDEN' });
  });

  it('the agent still cannot write a test input even alongside a draft [REQ-27, REQ-41]', async () => {
    const { svc, e, rows, port } = await setup();
    expect(Object.keys(port)).not.toContain('recordTest');
    const { assertWithinRails } = await import('../src/agents/rails');
    const before = await svc.engagement(e.id);
    const after = structuredClone(before);
    after.testDrafts[rows[0]] = draftFor(rows[0]);
    after.testInputs[rows[1]] = { ...INPUT, updatedBy: 'agent', updatedAt: 't' };
    expect(() => assertWithinRails(before, after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('accepting a draft records a human test record that names the draft and clears it [REQ-41]', async () => {
    const { svc, e, rows, save } = await setup();
    const d = draftFor(rows[0]);
    await save({ [rows[0]]: d });
    const fromDraft = { runId: d.draftedBy.runId, at: d.draftedBy.at };
    await svc.recordTest(e.id, rows[0], { ...INPUT, fromDraft }, auditor);
    const after = await svc.engagement(e.id);
    expect(after.testDrafts[rows[0]]).toBeUndefined();
    expect(JSON.stringify(after.testInputs[rows[0]])).not.toContain('fromDraft');
    const entry = (await readTrail(svc.db.kysely, e.id)).filter((b) => b.moduleId === 'human:test-record').at(-1)!;
    expect(entry.actor).toBe(auditor.id);
    expect(entry.inputs).toMatchObject({ rowId: rows[0], fromDraft });
  });

  it('a stale fromDraft is ignored and the record is plain human', async () => {
    const { svc, e, rows, save } = await setup();
    await save({ [rows[0]]: draftFor(rows[0]) });
    await svc.recordTest(e.id, rows[0], { ...INPUT, fromDraft: { runId: 'RUN-OLD', at: '2020-01-01T00:00:00.000Z' } }, auditor);
    const after = await svc.engagement(e.id);
    expect(after.testDrafts[rows[0]]).toBeDefined();
    expect(after.testInputs[rows[0]]).toBeDefined();
    expect(JSON.stringify(after.testInputs[rows[0]])).not.toContain('fromDraft');
    const entry = (await readTrail(svc.db.kysely, e.id)).filter((b) => b.moduleId === 'human:test-record').at(-1)!;
    expect('fromDraft' in (entry.inputs as object)).toBe(false);
    // no draft at all: also plain
    await svc.recordTest(e.id, rows[1], { ...INPUT, fromDraft: { runId: 'x', at: 'y' } }, auditor);
    expect((await svc.engagement(e.id)).testInputs[rows[1]]).toBeDefined();
  });

  it('accepting a draft whose cited document has since expired fails with EVIDENCE_EXPIRED', async () => {
    const { svc, e, rows, save } = await setup();
    const db = svc.db.kysely;
    const doc = await insertDocument(db, { sha256: 'a'.repeat(64), filename: 'log.pdf', mime: 'application/pdf', size: 10, kind: 'evidence', classification: 'internal', engagementId: e.id, uploadedBy: 'auditor' });
    const d = draftFor(rows[0], { evidence: [{ documentId: doc.id, quote: 'q' }] });
    await save({ [rows[0]]: d });
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${doc.id}`.execute(db);
    const err = await failure(svc.recordTest(e.id, rows[0], { ...INPUT, evidence: [{ documentId: doc.id }], fromDraft: { runId: d.draftedBy.runId, at: d.draftedBy.at } }, auditor));
    expect(err).toMatchObject({ status: 400, code: 'EVIDENCE_EXPIRED' });
    const after = await svc.engagement(e.id);
    expect(after.testDrafts[rows[0]]).toBeDefined();
    expect(after.testInputs[rows[0]]).toBeUndefined();
  });

  it('discard marks the draft personEdited with no proposal, trails it, and the agent cannot redraft it', async () => {
    const { svc, e, rows, save } = await setup();
    await save({ [rows[0]]: draftFor(rows[0]) });
    await expect(svc.discardTestDraft(e.id, rows[0], viewer)).rejects.toMatchObject({ status: 403 });
    await expect(svc.discardTestDraft(e.id, rows[1], auditor)).rejects.toMatchObject({ status: 404 });
    await svc.discardTestDraft(e.id, rows[0], auditor);
    const d = (await svc.engagement(e.id)).testDrafts[rows[0]];
    expect(d.personEdited).toBe(true);
    expect('proposal' in d).toBe(false);
    expect(d.evidence).toHaveLength(1);
    const entry = (await readTrail(svc.db.kysely, e.id)).filter((b) => b.moduleId === 'human:draft-discard').at(-1)!;
    expect(entry.inputs).toEqual({ rowId: rows[0] });
    expect(await failure(save({ [rows[0]]: draftFor(rows[0]) }))).toMatchObject({ code: 'AGENT_FORBIDDEN' });
  });

  it('refuses a draft filed under another row, and an empty write changes nothing [REQ-41]', async () => {
    const { svc, e, rows, save } = await setup();
    expect(await failure(save({ [rows[0]]: draftFor(rows[1]) }))).toMatchObject({ status: 400 });
    const v = (await svc.engagement(e.id)).version;
    const trail = (await readTrail(svc.db.kysely, e.id)).length;
    await save({});
    expect((await svc.engagement(e.id)).version).toBe(v);
    expect((await readTrail(svc.db.kysely, e.id)).length).toBe(trail);
  });

  it('a stale expectedVersion is a 409 VERSION_CONFLICT on save and on discard', async () => {
    const { svc, e, rows, port, acting } = await setup();
    await expect(port.saveTestDrafts(e.id, { [rows[0]]: draftFor(rows[0]) }, acting('test-draft'), { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    await port.saveTestDrafts(e.id, { [rows[0]]: draftFor(rows[0]) }, acting('test-draft'), { expectedVersion: (await svc.engagement(e.id)).version! });
    await expect(svc.discardTestDraft(e.id, rows[0], auditor, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('POST draft/discard: 404 without a draft, 403 for a viewer, 409 stale, 200 on success', async () => {
    const { svc, e, rows, save } = await setup();
    const { createApp } = await import('../src/app');
    const http = createApp(svc, { config: devAuthConfig(), oidc: null });
    const a = await signIn(http, 'auditor');
    const v = await signIn(http, 'viewer');
    const url = `/api/engagements/${e.id}/tests/${rows[0]}/draft/discard`;
    await a.post(url).expect(404);
    // The draft cites a document the auditor may read; a draft citing one they cannot is not served (evidence-drafts-http).
    const doc = await insertDocument(svc.db.kysely, { sha256: 'c'.repeat(64), filename: 'log.pdf', mime: 'application/pdf', size: 10, kind: 'evidence', classification: 'internal', engagementId: e.id, uploadedBy: 'auditor' });
    await save({ [rows[0]]: draftFor(rows[0], { evidence: [{ documentId: doc.id, page: 1, quote: 'late by 3h' }] }) });
    await v.post(url).expect(403);
    await a.agent.post(url).set('x-csrf-token', a.csrf).set('If-Match', '"1"').send({}).expect(409);
    const ok = await a.post(url).expect(200);
    const d = ok.body.testDrafts[rows[0]];
    expect(d.personEdited).toBe(true);
    expect('proposal' in d).toBe(false);
  });
});
