import crypto from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db';
import type { DB } from '../../db/schema';
import { appendTrail, type Executor } from '../../db/trail-repo';
import { ENGINE_VERSION } from '../../service';
import { chunkText } from '../chunk';
import { loadBundles, type Bundle, type Concept } from '../okf/bundle';

// Compiles OKF bundles into the knowledge graph (spec §6.3). One transaction for all packs:
// node history first (refusing content changed without a version bump), then the live nodes,
// curated edges and search chunks, then one trail entry. An unchanged pack is skipped entirely.

export class CompileError extends Error {}

export const COMPILE_ACTOR = 'system:packs';
/** Serialises compiles (two dev API processes starting together, or the CLI beside the API). */
const COMPILE_LOCK_KEY = 0x4b4e4f57;
/** Concept types that are searchable; pack headers and eval cases are not. */
const SEARCHABLE: ReadonlySet<Concept['type']> = new Set(['regulation', 'clause', 'control', 'risk']);
const BATCH = 500;

export interface PackCompileResult {
  packId: string;
  version: string;
  outcome: 'compiled' | 'unchanged';
}

export interface CompileResult {
  packs: PackCompileResult[];
  nodes: number;
  edges: number;
  chunks: number;
  deprecated: number;
  trailBundleId: string | null;
}

function nodeRow(b: Bundle, c: Concept) {
  return {
    id: c.nodeId, type: c.type, pack_id: b.packId, pack_version: b.version, concept_id: c.conceptId,
    title: c.title, description: c.description, body: c.body,
    tags: JSON.stringify(c.tags), sources: JSON.stringify(c.sources), attrs: JSON.stringify(c.attrs),
    generated: c.generated ? JSON.stringify(c.generated) : null,
    verified_by: c.verified?.by ?? null, verified_role: c.verified?.role ?? null, verified_at: c.verified?.at ?? null,
    status: c.status, stale_after: c.staleAfter, source_path: c.path, source_sha256: c.sha256, classification: b.classification,
  };
}
/** Every kg_nodes column a recompile overwrites (all but the id). */
const NODE_COLUMNS = [
  'type', 'pack_id', 'pack_version', 'concept_id', 'title', 'description', 'body', 'tags', 'sources', 'attrs', 'generated',
  'verified_by', 'verified_role', 'verified_at', 'status', 'stale_after', 'source_path', 'source_sha256', 'classification',
] as const;

/** What a search finds for a concept: its id and title, the regulation reference, then its text. */
export function searchableText(c: Concept): string {
  const a = c.attrs;
  const label = [a.regulation, a.ref].filter((x): x is string => typeof x === 'string').join(' ');
  return [`${c.conceptId}: ${c.title}`, label, c.description, c.body].filter(Boolean).join('\n\n');
}

async function inBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/** Refuses a bundle whose content differs from what was compiled before under the same version. */
async function checkHistory(trx: Transaction<DB>, b: Bundle) {
  const recorded = await trx
    .selectFrom('kg_node_versions')
    .select(['node_id', 'source_sha256'])
    .where('pack_version', '=', b.version)
    .where('node_id', 'like', `${b.packId}/%`)
    .execute();
  if (!recorded.length) return new Set<string>();
  const sha = new Map(recorded.map((r) => [r.node_id, r.source_sha256]));
  const bump = `bump the version in ${b.packId}/pack.md`;
  for (const c of b.concepts) {
    const was = sha.get(c.nodeId);
    if (was === undefined) throw new CompileError(`${c.path} was added after ${b.packId}@${b.version} was compiled; ${bump}`);
    if (was !== c.sha256) throw new CompileError(`${c.path} changed after ${b.packId}@${b.version} was compiled; ${bump}`);
  }
  const present = new Set(b.concepts.map((c) => c.nodeId));
  const gone = recorded.find((r) => !present.has(r.node_id));
  if (gone) throw new CompileError(`${gone.node_id} was removed after ${b.packId}@${b.version} was compiled; ${bump}`);
  return new Set(recorded.map((r) => r.node_id));
}

/** True when the live graph already holds exactly this bundle. */
async function isCurrent(trx: Transaction<DB>, b: Bundle): Promise<boolean> {
  const live = await trx.selectFrom('kg_nodes').select(['id', 'pack_version', 'source_sha256', 'status']).where('pack_id', '=', b.packId).execute();
  const byId = new Map(live.map((r) => [r.id, r]));
  const wanted = new Set(b.concepts.map((c) => c.nodeId));
  return (
    b.concepts.every((c) => {
      const r = byId.get(c.nodeId);
      return r && r.pack_version === b.version && r.source_sha256 === c.sha256 && r.status === c.status;
    }) && live.every((r) => wanted.has(r.id) || r.status === 'deprecated')
  );
}

async function compileBundle(trx: Transaction<DB>, b: Bundle, recorded: Set<string>, actor: string) {
  const fresh = b.concepts.filter((c) => !recorded.has(c.nodeId));
  await inBatches(fresh, (batch) =>
    trx.insertInto('kg_node_versions').values(batch.map((c) => ({
      node_id: c.nodeId, pack_version: b.version, source_sha256: c.sha256, snapshot: JSON.stringify(nodeRow(b, c)), compiled_by: actor,
    }))).execute(),
  );

  await inBatches(b.concepts, (batch) =>
    trx
      .insertInto('kg_nodes')
      .values(batch.map((c) => nodeRow(b, c)))
      .onConflict((oc) => oc.column('id').doUpdateSet((eb) => ({
        ...Object.fromEntries(NODE_COLUMNS.map((k) => [k, eb.ref(`excluded.${k}` as never)])),
        compiled_at: sql`now()`,
      }) as never))
      .execute(),
  );

  const ids = b.concepts.map((c) => c.nodeId);
  const dep = await trx.updateTable('kg_nodes').set({ status: 'deprecated' })
    .where('pack_id', '=', b.packId).where('id', 'not in', ids).where('status', '=', 'active').executeTakeFirst();

  const packNodes = trx.selectFrom('kg_nodes').select('id').where('pack_id', '=', b.packId);
  await trx.deleteFrom('kg_edges').where('origin', '=', 'curated').where('from_id', 'in', packNodes).execute();
  const approvedAt = new Date();
  const edges = b.concepts.flatMap((c) => c.links.map((l) => ({
    from_id: c.nodeId, to_id: l.target, rel: l.rel, origin: 'curated' as const, created_by: actor,
    source_ref: JSON.stringify({ path: c.path, ref: l.ref }), approved_by: `git:${b.packId}@${b.version}`, approved_at: approvedAt,
  })));
  await inBatches(edges, (batch) => trx.insertInto('kg_edges').values(batch).execute());

  await trx.deleteFrom('chunks').where('kg_node_id', 'in', packNodes).execute();
  const chunks = b.concepts
    .filter((c) => SEARCHABLE.has(c.type) && c.status === 'active')
    .flatMap((c) => chunkText(searchableText(c)).map((ch) => ({
      id: `KG:${c.nodeId}:${ch.ordinal}`, document_id: null, kg_node_id: c.nodeId, ordinal: ch.ordinal, page: null,
      text: ch.text, classification: b.classification, engagement_id: null,
    })));
  await inBatches(chunks, (batch) => trx.insertInto('chunks').values(batch).execute());

  return { nodes: b.concepts.length, edges: edges.length, chunks: chunks.length, deprecated: Number(dep.numUpdatedRows) };
}

export async function compilePacks(db: Db, bundles: Bundle[], actor = COMPILE_ACTOR): Promise<CompileResult> {
  return db.kysely.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${COMPILE_LOCK_KEY})`.execute(trx);
    const startedAt = new Date().toISOString();
    const result: CompileResult = { packs: [], nodes: 0, edges: 0, chunks: 0, deprecated: 0, trailBundleId: null };
    const compiled: { b: Bundle; counts: Awaited<ReturnType<typeof compileBundle>> }[] = [];

    for (const b of bundles) {
      const recorded = await checkHistory(trx, b);
      if (await isCurrent(trx, b)) {
        result.packs.push({ packId: b.packId, version: b.version, outcome: 'unchanged' });
        continue;
      }
      const counts = await compileBundle(trx, b, recorded, actor);
      compiled.push({ b, counts });
      result.packs.push({ packId: b.packId, version: b.version, outcome: 'compiled' });
      result.nodes += counts.nodes;
      result.edges += counts.edges;
      result.chunks += counts.chunks;
      result.deprecated += counts.deprecated;
    }

    if (compiled.length) {
      const now = new Date().toISOString();
      const sealed = await appendTrail(trx, {
        id: `KG-${crypto.randomBytes(8).toString('hex')}`,
        engagementId: null,
        moduleId: 'knowledge:compile',
        moduleVersion: ENGINE_VERSION,
        engineVersion: ENGINE_VERSION,
        packVersions: Object.fromEntries(compiled.map(({ b }) => [b.packId, b.version])),
        provider: { id: 'system', model: actor },
        promptHash: null,
        actor,
        startedAt,
        finishedAt: now,
        inputs: { packs: compiled.map(({ b }) => ({ id: b.packId, version: b.version, sha256: b.sha256 })) },
        retrievalSet: [],
        executionLog: compiled.map(({ b, counts }) => ({
          at: now, step: 'compile',
          detail: `${b.packId}@${b.version}: ${counts.nodes} nodes, ${counts.edges} edges, ${counts.chunks} chunks, ${counts.deprecated} deprecated`,
        })),
        qaActions: [],
        output: { nodes: result.nodes, edges: result.edges, chunks: result.chunks, deprecated: result.deprecated },
      });
      result.trailBundleId = sealed.id;
    }
    return result;
  });
}

/** Differences between the graph and the bundles in this release; empty when they match. */
export async function graphDrift(db: Executor, bundles: Bundle[]): Promise<string[]> {
  const live = await db.selectFrom('kg_nodes').select(['id', 'pack_version', 'source_sha256', 'status']).execute();
  const byId = new Map(live.map((r) => [r.id, r]));
  const drift: string[] = [];
  for (const b of bundles) {
    const head = byId.get(`${b.packId}/pack/${b.packId}`);
    if (!head) {
      drift.push(`${b.packId}: not compiled`);
      continue;
    }
    if (head.pack_version !== b.version) {
      drift.push(`${b.packId}: the graph has ${head.pack_version}, this release has ${b.version}`);
      continue;
    }
    const differ = b.concepts.filter((c) => {
      const r = byId.get(c.nodeId);
      return !r || r.source_sha256 !== c.sha256 || r.status !== c.status;
    });
    if (differ.length) drift.push(`${b.packId}@${b.version}: ${differ.length} concept(s) differ from the graph (first: ${differ[0].path})`);
  }
  return drift;
}

/**
 * The packs:compile release step: load and validate every bundle under the directory (a dangling
 * or out-of-pack link throws, naming the file and the link), then compile them. Nothing is written
 * unless every bundle loads.
 */
export async function compileDir(db: Db, packsDir: string, actor = COMPILE_ACTOR): Promise<CompileResult> {
  const bundles = loadBundles(packsDir);
  return compilePacks(db, bundles, actor);
}
