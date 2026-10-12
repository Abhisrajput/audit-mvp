import fs from 'node:fs';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { DB } from '../src/db/schema';
import { readTrail } from '../src/db/trail-repo';
import { verifyChain } from '../src/engine/trail';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { compileDir, compilePacks, graphDrift } from '../src/knowledge/graph/compile';
import { loadBundle, loadBundles } from '../src/knowledge/okf/bundle';
import { prepareRegistry, registryFromBundles, registryFromGraph } from '../src/knowledge/packs';
import { newService } from './helpers';
import { demoRoot } from './okf-fixtures';

const SHA = 'a'.repeat(64);

function nodeRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, type: 'clause', pack_id: 'p', pack_version: '0.2.0', concept_id: id.split('/').pop()!.toUpperCase(),
    title: 'T', description: 'D', body: '', tags: '[]', attrs: '{}', generated: null,
    verified_by: null, verified_role: null, verified_at: null, status: 'active', stale_after: null,
    source_path: `p/clauses/${id.split('/').pop()}.md`, source_sha256: SHA, classification: 'internal', ...over,
  } as const;
}

describe('knowledge-graph schema', () => {
  it('never deletes or truncates nodes, and keeps node history append-only', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await db.updateTable('kg_nodes').set({ status: 'deprecated' }).where('id', '=', 'p/clause/c1').execute();
    await expect(db.deleteFrom('kg_nodes').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE kg_nodes CASCADE`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);

    await db.insertInto('kg_node_versions').values({ node_id: 'p/clause/c1', pack_version: '0.2.0', source_sha256: SHA, snapshot: '{}', compiled_by: 'system:packs' }).execute();
    await expect(db.insertInto('kg_node_versions').values({ node_id: 'p/clause/c1', pack_version: '0.2.0', source_sha256: SHA, snapshot: '{}', compiled_by: 'x' }).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.updateTable('kg_node_versions').set({ snapshot: '{"a":1}' }).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.deleteFrom('kg_node_versions').execute()).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE kg_node_versions`.execute(db)).rejects.toThrow(/append-only: TRUNCATE/);
  });

  it('checks node fields and keeps concept ids unique per type', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c1-copy', { concept_id: 'C1' })).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c2', { type: 'opinion' })).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c3', { status: 'draft' })).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c4', { source_sha256: 'nope' })).execute()).rejects.toThrow(/check constraint/);
    // Verification is all or nothing: who, in what role, and when.
    await expect(db.insertInto('kg_nodes').values(nodeRow('p/clause/c5', { verified_by: 'Dr A' })).execute()).rejects.toThrow(/check constraint/);
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c6', { verified_by: 'Dr A', verified_role: 'QA SME', verified_at: '2026-10-01' })).execute();
  });

  it('links edges to existing nodes and requires curated edges to be approved', async () => {
    const db = (await newService()).db.kysely;
    await db.insertInto('kg_nodes').values([nodeRow('p/control/k1', { type: 'control' }), nodeRow('p/clause/c1')]).execute();
    const edge = { from_id: 'p/control/k1', to_id: 'p/clause/c1', rel: 'cites', origin: 'curated', created_by: 'system:packs', approved_by: 'git:p@0.2.0', approved_at: new Date() } as const;
    await db.insertInto('kg_edges').values(edge).execute();
    await expect(db.insertInto('kg_edges').values(edge).execute()).rejects.toThrow(/duplicate key/);
    await expect(db.insertInto('kg_edges').values({ ...edge, to_id: 'p/clause/missing' }).execute()).rejects.toThrow(/foreign key/);
    await expect(db.insertInto('kg_edges').values({ ...edge, rel: 'Cites!' }).execute()).rejects.toThrow(/check constraint/);
    await expect(db.insertInto('kg_edges').values({ ...edge, rel: 'tests', approved_by: null, approved_at: null }).execute()).rejects.toThrow(/check constraint/);
    await db.insertInto('kg_edges').values({ ...edge, rel: 'relates_to', origin: 'proposed', approved_by: null, approved_at: null }).execute();
  });

  it('ties knowledge-graph chunks to a node, one per ordinal', async () => {
    const db = (await newService()).db.kysely;
    const chunk = { id: 'KG:p/clause/c1:0', document_id: null, kg_node_id: 'p/clause/c1', ordinal: 0, page: null, text: 'node text', classification: 'internal', engagement_id: null } as const;
    await expect(db.insertInto('chunks').values(chunk).execute()).rejects.toThrow(/foreign key/);
    await db.insertInto('kg_nodes').values(nodeRow('p/clause/c1')).execute();
    await db.insertInto('chunks').values(chunk).execute();
    await expect(db.insertInto('chunks').values({ ...chunk, id: 'KG:other' }).execute()).rejects.toThrow(/duplicate key/);
  });

  it('lets any chunk get its embedding once and changes nothing else', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const db = svc.db.kysely;
    const d = await insertDocument(db, {
      sha256: 'b'.repeat(64), filename: 'sop.txt', mime: 'text/plain', size: 10, kind: 'sop',
      classification: 'internal', engagementId: null, uploadedBy: 'auditor',
    });
    await setDocumentText(db, d, { extractor: 'test', extractorVersion: '1', text: 'Some text.' });
    const id = (await db.selectFrom('chunks').select('id').where('document_id', '=', d.id).executeTakeFirstOrThrow()).id;

    await db.updateTable('chunks').set({ embedding: '[1,2,3]' }).where('id', '=', id).execute();
    await expect(db.updateTable('chunks').set({ embedding: '[3,2,1]' }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.updateTable('chunks').set({ embedding: null }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.updateTable('chunks').set({ text: 'changed' }).where('id', '=', id).execute()).rejects.toThrow(/append-only: UPDATE/);
  });
});

const count = async (db: Kysely<DB>, table: 'kg_nodes' | 'kg_edges' | 'kg_node_versions' | 'chunks' | 'trail') =>
  Number((await db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
const TABLES = ['kg_nodes', 'kg_edges', 'kg_node_versions', 'chunks', 'trail'] as const;
const counts = (db: Kysely<DB>) => Promise.all(TABLES.map((t) => count(db, t)));

/** Rewrites one file of the demo bundle on disk. */
function edit(root: string, rel: string, change: (text: string) => string) {
  const file = path.join(root, 'demo', rel);
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
}

describe('compiling bundles', () => {
  it('compiles the real packs into a graph the registry can be built from, in one trailed step', async () => {
    const svc = await newService();
    const bundles = loadBundles();
    const r = await compilePacks(svc.db, bundles);
    const concepts = bundles.flatMap((b) => b.concepts);

    expect(r.packs).toEqual(bundles.map((b) => ({ packId: b.packId, version: '0.2.0', outcome: 'compiled' })));
    expect(r.nodes).toBe(concepts.length);
    expect(r.edges).toBe(concepts.reduce((n, c) => n + c.links.length, 0));
    expect(r.edges).toBeGreaterThan(0);
    expect(await count(svc.db.kysely, 'kg_nodes')).toBe(concepts.length);
    expect(await count(svc.db.kysely, 'kg_node_versions')).toBe(concepts.length);

    const chunks = await svc.db.kysely.selectFrom('chunks').selectAll().where('kg_node_id', 'is not', null).execute();
    expect(chunks.length).toBe(r.chunks);
    expect(new Set(chunks.map((c) => c.classification))).toEqual(new Set(['internal']));
    expect(chunks.every((c) => c.engagement_id === null && c.document_id === null)).toBe(true);
    const clauseChunk = chunks.find((c) => c.kg_node_id === 'pharma/clause/21cfr211-22')!;
    expect(clauseChunk.text).toMatch(/^21CFR211\.22: /);
    expect(chunks.some((c) => c.kg_node_id!.includes('/eval_case/') || c.kg_node_id!.includes('/pack/'))).toBe(false);

    expect((await registryFromGraph(svc.db.kysely)).list()).toEqual(registryFromBundles().list());

    const trail = await readTrail(svc.db.kysely);
    const compiled = trail.filter((b) => b.moduleId === 'knowledge:compile');
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toMatchObject({ id: r.trailBundleId, engagementId: null, actor: 'system:packs', packVersions: { common: '0.2.0', food: '0.2.0', pharma: '0.2.0' } });
    expect(compiled[0].inputs).toEqual({ packs: bundles.map((b) => ({ id: b.packId, version: b.version, sha256: b.sha256 })) });
    expect(verifyChain(trail).valid).toBe(true);
  });

  it('does nothing when the same bundles are compiled again', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    await compilePacks(svc.db, loadBundles());
    const before = await counts(db);
    const again = await compilePacks(svc.db, loadBundles());
    expect(again.packs.every((p) => p.outcome === 'unchanged')).toBe(true);
    expect(again.trailBundleId).toBeNull();
    expect(await counts(db)).toEqual(before);
  });

  it('refuses content that changed without a version bump and writes nothing', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    const root = demoRoot();
    await compilePacks(svc.db, [loadBundle(root, 'demo')]);
    const sha = (await db.selectFrom('kg_nodes').select('source_sha256').where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow()).source_sha256;
    const trailBefore = await count(db, 'trail');

    edit(root, 'clauses/ds-1.md', (t) => t.replace('A records policy exists.', 'A records policy exists and is approved.'));
    await expect(compilePacks(svc.db, [loadBundle(root, 'demo')])).rejects.toThrow(
      /demo\/clauses\/ds-1\.md changed after demo@0\.2\.0 was compiled; bump the version in demo\/pack\.md/,
    );
    expect((await db.selectFrom('kg_nodes').select('source_sha256').where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow()).source_sha256).toBe(sha);
    expect(await count(db, 'trail')).toBe(trailBefore);

    const added = demoRoot((f) => f.set('clauses/ds-3.md', f.get('clauses/ds-1.md')!.replace('id: DS-1', 'id: DS-3')));
    await expect(compilePacks(svc.db, [loadBundle(added, 'demo')])).rejects.toThrow(/demo\/clauses\/ds-3\.md was added after demo@0\.2\.0 was compiled/);

    const removed = demoRoot((f) => f.delete('eval/dm-r1.md'));
    await expect(compilePacks(svc.db, [loadBundle(removed, 'demo')])).rejects.toThrow(/demo\/eval_case\/dm-r1 was removed after demo@0\.2\.0 was compiled/);
  });

  it('applies a new version: updates nodes, deprecates removed ones, keeps every version in history', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    await compilePacks(svc.db, [loadBundle(demoRoot(), 'demo')]);

    const next = demoRoot((f) => {
      f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.3.0'));
      f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('A records policy exists.', 'A records retention policy exists.'));
      f.delete('eval/dm-r1.md');
    });
    const r = await compilePacks(svc.db, [loadBundle(next, 'demo')]);
    expect(r.packs).toEqual([{ packId: 'demo', version: '0.3.0', outcome: 'compiled' }]);
    expect(r.deprecated).toBe(1);

    const evalNode = await db.selectFrom('kg_nodes').selectAll().where('id', '=', 'demo/eval_case/dm-r1').executeTakeFirstOrThrow();
    expect(evalNode.status).toBe('deprecated');
    const clause = await db.selectFrom('kg_nodes').selectAll().where('id', '=', 'demo/clause/ds-1').executeTakeFirstOrThrow();
    expect(clause).toMatchObject({ pack_version: '0.3.0', description: 'A records retention policy exists.' });
    const history = await db.selectFrom('kg_node_versions').select('pack_version').where('node_id', '=', 'demo/clause/ds-1').orderBy('pack_version').execute();
    expect(history.map((h) => h.pack_version)).toEqual(['0.2.0', '0.3.0']);
    const chunkText = (await db.selectFrom('chunks').select('text').where('kg_node_id', '=', 'demo/clause/ds-1').execute()).map((c) => c.text).join(' ');
    expect(chunkText).toMatch(/retention/);
    expect((await registryFromGraph(db)).get('demo').evalCases).toEqual([]);
  });

  it('builds a production registry only from a graph that matches the release', async () => {
    const svc = await newService();
    const logs: string[] = [];
    const bundles = [loadBundle(demoRoot(), 'demo')];
    await expect(prepareRegistry(svc.db, bundles, { production: true })).rejects.toThrow(/does not match the content packs in this release:\n {2}- demo: not compiled/);

    const reg = await prepareRegistry(svc.db, bundles, { production: false, log: (l) => logs.push(l) });
    expect(reg.get('demo').clauses.map((c) => c.id)).toEqual(['DS-1', 'DS-2']);
    expect(logs.join()).toMatch(/demo@0\.2\.0 compiled/);
    await prepareRegistry(svc.db, bundles, { production: true });

    const bumped = [loadBundle(demoRoot((f) => f.set('pack.md', f.get('pack.md')!.replace('version: 0.2.0', 'version: 0.2.1'))), 'demo')];
    await expect(prepareRegistry(svc.db, bumped, { production: true })).rejects.toThrow(/demo: the graph has 0\.2\.0, this release has 0\.2\.1/);
    const edited = [loadBundle(demoRoot((f) => f.set('clauses/ds-2.md', f.get('clauses/ds-2.md')!.replace('kept and reviewed', 'kept'))), 'demo')];
    expect(await graphDrift(svc.db.kysely, edited)).toEqual(['demo@0.2.0: 1 concept(s) differ from the graph (first: demo/clauses/ds-2.md)']);
  });

  it('packs:compile rejects a dangling link, naming the file and the link, and writes nothing', async () => {
    const svc = await newService();
    const db = svc.db.kysely;
    const root = demoRoot();
    await compileDir(svc.db, root);
    const before = await counts(db);
    expect(before[0]).toBeGreaterThan(0);
    const trailBefore = await readTrail(db);

    // A real release mistake: the version is bumped, but a control now cites a clause that does not exist.
    edit(root, 'pack.md', (t) => t.replace('version: 0.2.0', 'version: 0.3.0'));
    edit(root, 'controls/dm-01.md', (t) => t.replace('/clauses/ds-1.md', '/clauses/ds-404.md'));
    await expect(compileDir(svc.db, root)).rejects.toThrow(/demo\/controls\/dm-01\.md: link "\/clauses\/ds-404\.md"/);

    expect(await counts(db)).toEqual(before);
    expect(await readTrail(db)).toEqual(trailBefore);
    const versions = await db.selectFrom('kg_nodes').select('pack_version').distinct().execute();
    expect(versions.map((v) => v.pack_version)).toEqual(['0.2.0']);
  });
});
