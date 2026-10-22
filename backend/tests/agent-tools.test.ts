import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { agentPort } from '../src/agents/port';
import { listSteps } from '../src/agents/run-repo';
import { nodeNeighbourhood, SearchArgs, searchKnowledge } from '../src/agents/tools/knowledge';
import { readDocument } from '../src/agents/tools/documents';
import { mayUse, TOOL_ALLOW_LIST, Toolbox } from '../src/agents/tools/toolbox';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { compilePacks } from '../src/knowledge/graph/compile';
import { loadBundles } from '../src/knowledge/okf/bundle';
import type { AuditService } from '../src/service';
import { admin, auditor, leasedRun, NEW_ENGAGEMENT, newService } from './helpers';

describe('knowledge tools for agents', () => {
  let svc: AuditService;

  beforeAll(async () => {
    svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    await compilePacks(svc.db, loadBundles());
    for (const classification of ['internal', 'restricted'] as const) {
      const d = await insertDocument(svc.db.kysely, {
        sha256: classification.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64), filename: `${classification}.pdf`, mime: 'application/pdf',
        size: 10, kind: 'sop', classification, engagementId: null, uploadedBy: 'auditor',
      });
      await setDocumentText(svc.db.kysely, d, { extractor: 'test', extractorVersion: '1', text: `Allergen changeover swab procedure (${classification}).`, pageStarts: [0] });
    }
  });

  /** A toolbox for `agent` on a fresh engagement with a leased run (an engagement has one active run at a time). */
  async function toolbox(agent: string) {
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const { run } = await leasedRun(svc, e.id);
    return { box: new Toolbox({ db: svc.db.kysely, port: agentPort(svc), run, starter: auditor, engagement: e }, agent), run, e };
  }

  it("searches only what the run's starter may read [REQ-23]", async () => {
    const hits = await searchKnowledge(svc.db.kysely, auditor, 'ENG-NONE', { query: 'allergen swab', limit: 10 });
    const titles = hits.map((h) => h.title);
    expect(titles).toContain('internal.pdf');
    expect(titles).not.toContain('restricted.pdf');
  });

  it('shows a concept and its approved neighbours one hop away, only those the reader may see [REQ-23]', async () => {
    const n = await nodeNeighbourhood(svc.db.kysely, auditor, { conceptId: 'FD-HACCP-03' });
    expect(n.node).toMatchObject({ conceptId: 'FD-HACCP-03', type: 'control' });
    const cited = n.neighbours.filter((x) => x.direction === 'out' && x.rel === 'cites');
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((x) => x.node.type === 'clause')).toBe(true);
    const hidden = cited[0].node.nodeId;
    await sql`UPDATE kg_nodes SET classification = 'restricted' WHERE id = ${hidden}`.execute(svc.db.kysely);
    try {
      expect((await nodeNeighbourhood(svc.db.kysely, auditor, { conceptId: 'FD-HACCP-03' })).neighbours.map((x) => x.node.nodeId)).not.toContain(hidden);
    } finally {
      await sql`UPDATE kg_nodes SET classification = 'internal' WHERE id = ${hidden}`.execute(svc.db.kysely);
    }
    expect(await nodeNeighbourhood(svc.db.kysely, admin, { conceptId: 'FD-HACCP-03' })).toEqual({ node: null, neighbours: [] });
    expect((await nodeNeighbourhood(svc.db.kysely, auditor, { conceptId: 'NOT-A-CONCEPT' })).node).toBeNull();
  });

  it('allows the test-plan and QA agents both tools, and every other agent none [REQ-26]', () => {
    expect(TOOL_ALLOW_LIST).toEqual({
      'test-plan': ['search_knowledge', 'node_neighbourhood'], qa: ['search_knowledge', 'node_neighbourhood'], evidence: ['search_knowledge', 'read_document'],
    });
    for (const agent of ['supervisor', 'scope', 'rcm', 'testing', 'gaps', 'report']) expect(mayUse(agent, 'search_knowledge')).toBe(false);
    expect(mayUse('qa', 'sign_gate')).toBe(false);
  });

  it('refuses a tool off the agent’s allow-list before running it [REQ-26]', async () => {
    const { box, run } = await toolbox('scope');
    await expect(box.call('search_knowledge', { query: 'allergen' })).rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' });
    expect(await listSteps(svc.db.kysely, run.id)).toEqual([]);
  });

  it('records every tool call as a step and in the trail, by result ids only [REQ-28]', async () => {
    const { box, run, e } = await toolbox('qa');
    const hits = await box.call('search_knowledge', { query: 'allergen swab' });
    const [step] = await listSteps(svc.db.kysely, run.id);
    expect(step).toMatchObject({ kind: 'tool_call', agent: 'qa', decision: { tool: 'search_knowledge', args: { query: 'allergen swab' }, resultIds: (hits as { id: string }[]).map((h) => h.id) } });
    expect(JSON.stringify(step.decision)).not.toContain('swab procedure');
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === step.trailBundleId)).toMatchObject({ moduleId: 'agent:tool', actor: 'agent:qa', inputs: { runId: run.id, onBehalfOf: 'auditor' } });
  });

  it('turns down lookups a model asks for that are off the allow-list or malformed, logs them, and takes at most three [REQ-26]', async () => {
    const { box, run } = await toolbox('qa');
    const results = await box.lookups([
      { tool: 'sign_gate', args: { gateId: 'GATE-1' } },
      { tool: 'search_knowledge', args: { query: '' } },
      { tool: 'search_knowledge', args: { query: 'allergen' } },
      { tool: 'node_neighbourhood', args: { conceptId: 'FD-HACCP-03' } },
    ]);
    expect(results.map((r) => (r.refused ? 'refused' : 'ran'))).toEqual(['refused', 'refused', 'ran']);
    expect(results[0].refused).toMatch(/not on the qa agent's allow-list/);
    const steps = await listSteps(svc.db.kysely, run.id);
    expect(steps.map((s) => (s.decision as { tool: string }).tool)).toEqual(['sign_gate', 'search_knowledge', 'search_knowledge']);
    expect(steps[0].decision).toMatchObject({ refused: expect.any(String), resultIds: [] });
  });

  it('records the parsed arguments of a call, and at most 500 characters of a refused lookup’s raw arguments [REQ-28]', async () => {
    const { box, run, e } = await toolbox('qa');
    await box.call('search_knowledge', { query: '  allergen  ' });
    await box.lookups([
      { tool: 'sign_gate', args: { gateId: 'G'.repeat(5000) } },
      { tool: 'search_knowledge', args: { query: 'allergen', extra: 'x'.repeat(5000) } },
    ]);
    const steps = await listSteps(svc.db.kysely, run.id);
    const args = steps.map((s) => (s.decision as { args: unknown }).args);
    expect(args[0]).toEqual(SearchArgs.parse({ query: '  allergen  ' }));
    expect(args[0]).toEqual({ query: 'allergen', limit: 5 });
    for (const raw of args.slice(1)) {
      expect(typeof raw).toBe('string');
      expect((raw as string).length).toBe(500);
    }
    const trail = await readTrail(svc.db.kysely, e.id);
    for (const s of steps.slice(1)) {
      const inputs = trail.find((b) => b.id === s.trailBundleId)!.inputs as { args: unknown };
      expect(inputs.args).toEqual((s.decision as { args: unknown }).args);
    }
  });

  it('keeps the same 50 neighbours, in order, however many a concept has', async () => {
    const db = (await newService()).db.kysely;
    const row = (id: string, type: 'control' | 'clause') => ({
      id, type, pack_id: 'p', pack_version: '0.1.0', concept_id: id.split('/').pop()!.toUpperCase(), title: id, description: null, body: '',
      tags: '[]', attrs: '{}', generated: null, verified_by: null, verified_role: null, verified_at: null, status: 'active', stale_after: null,
      source_path: `${id}.md`, source_sha256: 'a'.repeat(64), classification: 'internal',
    } as const);
    // 60 neighbours, written in descending id order so that table order is not the order asked for. The 30 highest ids
    // are linked by a relation that sorts first, so a cut by id alone would keep the wrong 50.
    const ids = Array.from({ length: 60 }, (_, i) => `p/clause/c${String(59 - i).padStart(3, '0')}`);
    const relOf = (id: string) => (Number(id.slice(-3)) >= 30 ? 'applies_to' : 'cites');
    await db.insertInto('kg_nodes').values([row('p/control/k0', 'control'), ...ids.map((id) => row(id, 'clause'))]).execute();
    await db.insertInto('kg_edges').values(ids.map((to_id) => ({
      from_id: 'p/control/k0', to_id, rel: relOf(to_id), origin: 'curated' as const, created_by: 'system:packs', approved_by: 'git:p@0.1.0', approved_at: new Date(),
    }))).execute();
    const ascending = [...ids].reverse();
    const want = [...ascending.filter((id) => relOf(id) === 'applies_to'), ...ascending.filter((id) => relOf(id) === 'cites')].slice(0, 50);
    const n = await nodeNeighbourhood(db, auditor, { conceptId: 'K0' });
    expect(n.neighbours.map((x) => `${x.rel}:${x.node.nodeId}`)).toEqual(want.map((id) => `${relOf(id)}:${id}`));
  });

  it('records nothing once the worker has lost the run', async () => {
    const { box, run } = await toolbox('qa');
    await sql`UPDATE agent_runs SET lease_owner = 'someone-else' WHERE id = ${run.id}`.execute(svc.db.kysely);
    await expect(box.call('search_knowledge', { query: 'allergen' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  let shaN = 0;
  async function doc(over: { engagementId: string | null; kind?: 'evidence' | 'sop'; classification?: 'internal' | 'restricted'; pages?: string[]; text?: string }) {
    const d = await insertDocument(svc.db.kysely, {
      sha256: (++shaN).toString(16).padStart(64, 'e'), filename: `doc${shaN}.pdf`, mime: 'application/pdf', size: 10,
      kind: over.kind ?? 'evidence', classification: over.classification ?? 'internal', engagementId: over.engagementId, uploadedBy: 'auditor',
    });
    const pages = over.pages ?? [over.text ?? 'Cold room temperature log, all readings within range.'];
    let at = 0;
    const pageStarts = pages.map((p) => { const s = at; at += p.length; return s; });
    await setDocumentText(svc.db.kysely, d, { extractor: 'test', extractorVersion: '1', text: pages.join(''), pageStarts: over.pages ? pageStarts : [] });
    return d;
  }

  it('read_document returns page text for an engagement evidence document and trails the call', async () => {
    const { box, run, e } = await toolbox('evidence');
    const d = await doc({ engagementId: e.id, pages: ['Page one text. ', 'Page two text. ', 'Page three text.'] });
    const out = await box.call('read_document', { documentId: d.id, pages: [2, 3] });
    expect(out).toEqual({ documentId: d.id, filename: d.filename, pages: [{ page: 2, text: 'Page two text. ' }, { page: 3, text: 'Page three text.' }], truncated: false });
    const all = await box.call('read_document', { documentId: d.id });
    expect(all).toMatchObject({ pages: [{ page: 1 }, { page: 2 }, { page: 3 }], truncated: false });
    const steps = await listSteps(svc.db.kysely, run.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: 'tool_call', agent: 'evidence', decision: { tool: 'read_document', args: { documentId: d.id, pages: [2, 3] }, resultIds: [d.id] } });
    expect(JSON.stringify(steps[0].decision)).not.toContain('Page two');
    expect((await readTrail(svc.db.kysely, e.id)).find((b) => b.id === steps[0].trailBundleId)).toMatchObject({ moduleId: 'agent:tool', actor: 'agent:evidence' });
    const [lookup] = await box.lookups([{ tool: 'read_document', args: { documentId: d.id, pages: [1] } }, { tool: 'read_document', args: { documentId: d.id, pages: [] , extra: 1 } }]);
    expect(lookup.result).toMatchObject({ pages: [{ page: 1 }] });
    expect((await box.lookups([{ tool: 'read_document', args: { documentId: d.id, extra: 1 } }]))[0].refused).toMatch(/not valid/);
  });

  it('read_document refuses global, other-engagement, unreadable and expired documents alike', async () => {
    const { box, e } = await toolbox('evidence');
    const other = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const cases = {
      missing: { id: 'DOC-NOPE' },
      global: await doc({ engagementId: null }),
      otherEngagement: await doc({ engagementId: other.id }),
      unreadable: await doc({ engagementId: e.id, classification: 'restricted' }),
      expired: await doc({ engagementId: e.id }),
      notEvidence: await doc({ engagementId: e.id, kind: 'sop' }),
    };
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${cases.expired.id}`.execute(svc.db.kysely);
    const bodies: string[] = [];
    for (const [name, d] of Object.entries(cases)) {
      const err = await box.call('read_document', { documentId: d.id }).then(() => null, (x: unknown) => x as { status: number; code: string; message: string });
      expect(err, name).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      bodies.push(err!.message.replace(d.id, '<id>'));
    }
    expect(new Set(bodies).size).toBe(1);
    await expect(readDocument(svc.db.kysely, admin, e.id, { documentId: (await doc({ engagementId: e.id })).id })).rejects.toMatchObject({ status: 404 });
  });

  it('read_document caps at 6 pages and 12 000 chars with truncated: true', async () => {
    const { box, e } = await toolbox('evidence');
    const many = await doc({ engagementId: e.id, pages: Array.from({ length: 8 }, (_, i) => `P${i + 1} `.padEnd(100, 'x')) });
    const six = (await box.call('read_document', { documentId: many.id })) as { pages: { page: number }[]; truncated: boolean };
    expect(six.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(six.truncated).toBe(true);
    await expect(box.call('read_document', { documentId: many.id, pages: [1, 2, 3, 4, 5, 6, 7] })).rejects.toThrow();
    await expect(box.call('read_document', { documentId: many.id, pages: [9] })).rejects.toMatchObject({ status: 400 });
    const big = await doc({ engagementId: e.id, pages: Array.from({ length: 6 }, () => 'y'.repeat(3000)) });
    const capped = (await box.call('read_document', { documentId: big.id })) as { pages: { text: string }[]; truncated: boolean };
    expect(capped.pages.reduce((n, p) => n + p.text.length, 0)).toBe(12000);
    expect(capped.pages).toHaveLength(4);
    expect(capped.truncated).toBe(true);
    const flat = await doc({ engagementId: e.id, text: 'z'.repeat(20000) });
    const one = (await box.call('read_document', { documentId: flat.id })) as { pages: { page: number | null; text: string }[]; truncated: boolean };
    expect(one.pages).toEqual([{ page: null, text: 'z'.repeat(12000) }]);
    expect(one.truncated).toBe(true);
  });

  it('the evidence agent may use search_knowledge and read_document only, and its search is scoped to evidence kinds', async () => {
    const { box, e, run } = await toolbox('evidence');
    await doc({ engagementId: e.id, text: 'Zebrafish quarantine log for the allergen room.' });
    await doc({ engagementId: e.id, kind: 'sop', text: 'Zebrafish quarantine procedure for the allergen room.' });
    await expect(box.call('node_neighbourhood', { conceptId: 'FD-HACCP-03' })).rejects.toMatchObject({ status: 403, code: 'AGENT_FORBIDDEN' });
    const hits = (await box.call('search_knowledge', { query: 'zebrafish quarantine' })) as { kind: string; snippet: string; documentId?: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('log');
    expect(hits[0].documentId).toEqual(expect.any(String));
    expect(await listSteps(svc.db.kysely, run.id)).toHaveLength(1);
    const planner = await toolbox('test-plan');
    await doc({ engagementId: planner.e.id, kind: 'sop', text: 'Zebrafish quarantine procedure for the allergen room.' });
    const planHits = (await planner.box.call('search_knowledge', { query: 'zebrafish quarantine' })) as { snippet: string }[];
    expect(planHits.some((h) => h.snippet.includes('procedure'))).toBe(true);
  });
});
