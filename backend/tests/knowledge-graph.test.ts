import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { newService } from './helpers';

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
