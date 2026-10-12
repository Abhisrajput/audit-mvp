import type { Selectable } from 'kysely';
import type { Db } from '../db';
import type { KgNodesTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { PackRegistry } from '../engine/packs';
import { compilePacks, graphDrift } from './graph/compile';
import { DEFAULT_PACKS_DIR, EXTERNAL, loadBundles, type Bundle, type Concept } from './okf/bundle';
import { bundleToContentPack } from './okf/to-pack';

// Where the engine's PackRegistry comes from. Tests use the bundles on disk; the API and
// the eval CLI read the compiled knowledge graph (registryFromGraph, plan 1E Task 4).

export function registryFromBundles(dir = DEFAULT_PACKS_DIR): PackRegistry {
  return new PackRegistry(loadBundles(dir).map(bundleToContentPack));
}

function rowToConcept(r: Selectable<KgNodesTable>): Concept {
  return {
    nodeId: r.id, type: r.type, packId: r.pack_id, conceptId: r.concept_id, path: r.source_path, sha256: r.source_sha256,
    title: r.title, description: r.description, body: r.body, tags: r.tags, sources: r.sources, attrs: r.attrs,
    generated: r.generated,
    verified: r.verified_by ? { by: r.verified_by, role: r.verified_role!, at: r.verified_at! } : null,
    status: r.status, staleAfter: r.stale_after,
    externalSources: r.sources.map((s) => s.ref).filter((ref) => EXTERNAL.test(ref)),
    links: [],
  };
}

/** The registry the API serves: active concepts of the given packs, as compiled into the graph. */
export async function registryFromGraph(db: Executor, packIds?: string[]): Promise<PackRegistry> {
  if (packIds && !packIds.length) return new PackRegistry([]);
  let q = db.selectFrom('kg_nodes').selectAll().where('status', '=', 'active');
  if (packIds) q = q.where('pack_id', 'in', packIds);
  const rows = await q.execute();
  const byPack = new Map<string, Selectable<KgNodesTable>[]>();
  for (const r of rows) byPack.set(r.pack_id, [...(byPack.get(r.pack_id) ?? []), r]);
  const bundles: Bundle[] = [...byPack.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([packId, nodes]) => {
    const head = nodes.find((n) => n.type === 'pack');
    if (!head) throw new Error(`Knowledge graph has concepts of pack ${packId} but no pack node; run packs:compile`);
    return { packId, version: head.pack_version, classification: head.classification, sha256: '', concepts: nodes.map(rowToConcept) };
  });
  return new PackRegistry(bundles.map(bundleToContentPack));
}

/**
 * Start-up: outside production, compile the bundles (a no-op when unchanged); in production never
 * compile, and refuse to start unless the graph holds exactly the bundles shipped with this release.
 */
export async function prepareRegistry(db: Db, bundles: Bundle[], opts: { production: boolean; log?: (line: string) => void }): Promise<PackRegistry> {
  const log = opts.log ?? console.log;
  if (opts.production) {
    const drift = await graphDrift(db.kysely, bundles);
    if (drift.length) {
      throw new Error(
        `The knowledge graph does not match the content packs in this release:\n  - ${drift.join('\n  - ')}\n` +
          'Run "npm run packs:compile" (in the container: node dist/knowledge/packs-cli.js compile) first; ' +
          'the API never compiles packs in production.',
      );
    }
  } else {
    const r = await compilePacks(db, bundles);
    log(`Content packs: ${r.packs.map((p) => `${p.packId}@${p.version} ${p.outcome}`).join(', ')}`);
  }
  return registryFromGraph(db.kysely, bundles.map((b) => b.packId));
}
