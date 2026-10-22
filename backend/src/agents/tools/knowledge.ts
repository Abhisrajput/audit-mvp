import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { DB, KgNodesTable } from '../../db/schema';
import type { User } from '../../engine/types';
import { todayUtc, trustProblems } from '../../engine/trust';
import { CLASSIFICATIONS_BY_ROLE, type DocumentKind } from '../../knowledge/access';
import { PgFtsRetriever } from '../../knowledge/retriever';

// The agents' knowledge tools (spec §2 tools/). Both run with the visibility of the person who started the run: an
// agent never reads anything its starter could not (REQ-23).

export const TOOL_NAMES = ['search_knowledge', 'node_neighbourhood', 'read_document'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const SearchArgs = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).default(5) }).strict();
export const NeighbourhoodArgs = z.object({ conceptId: z.string().trim().min(1).max(100) }).strict();

export interface KnowledgeHit {
  id: string;
  kind: 'chunk' | 'kg_node';
  title: string;
  snippet: string;
  /** Whether a finding may cite it (the trust rules, REQ-22). */
  citable: boolean;
  /** Where it came from: a concept id, or a file and page. */
  source: string;
  /** For chunk hits: the document and page it is from. */
  documentId?: string;
  page?: number | null;
}

/** Full-text search over documents and the knowledge graph, filtered inside the database query to what `user` may read. */
export async function searchKnowledge(db: Kysely<DB>, user: User, engagementId: string, args: z.infer<typeof SearchArgs>, scope?: { kinds?: readonly DocumentKind[] }): Promise<KnowledgeHit[]> {
  const hits = await new PgFtsRetriever(db).search(args.query, { user, engagementId, limit: args.limit, kinds: scope?.kinds });
  return hits.map((h) => ({
    id: h.id, kind: h.kind, title: h.title, snippet: h.snippet, citable: h.citable,
    source: h.kind === 'kg_node' ? h.citation.conceptId : `${h.citation.filename}${h.citation.page ? ` p.${h.citation.page}` : ''}`,
    ...(h.kind === 'chunk' ? { documentId: h.citation.documentId, page: h.citation.page } : {}),
  }));
}

export interface GraphNode {
  nodeId: string;
  conceptId: string;
  type: string;
  title: string;
  citable: boolean;
}

export interface Neighbour {
  rel: string;
  /** 'out': the concept points at the neighbour (e.g. a control cites a clause); 'in': the neighbour points at it. */
  direction: 'out' | 'in';
  node: GraphNode;
}

export interface Neighbourhood {
  node: GraphNode | null;
  neighbours: Neighbour[];
}

function toNode(n: Selectable<KgNodesTable>, today: string): GraphNode {
  const problems = trustProblems({
    nodeId: n.id, verifiedBy: n.verified_by, verifiedRole: n.verified_role, verifiedAt: n.verified_at, status: n.status, staleAfter: n.stale_after, sourcePath: n.source_path,
  }, today);
  return { nodeId: n.id, conceptId: n.concept_id, type: n.type, title: n.title, citable: problems.length === 0 };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A concept and its neighbours one hop away in both directions, over approved edges only (curated ones, or ones a person
 * approved). Only active nodes `user` may read are returned, ordered by relation, direction and node id.
 */
export async function nodeNeighbourhood(db: Kysely<DB>, user: User, args: z.infer<typeof NeighbourhoodArgs>): Promise<Neighbourhood> {
  const allowed = [...CLASSIFICATIONS_BY_ROLE[user.role]];
  if (!allowed.length) return { node: null, neighbours: [] };
  const today = todayUtc();
  const node = await db
    .selectFrom('kg_nodes')
    .selectAll()
    .where('concept_id', '=', args.conceptId)
    .where('status', '=', 'active')
    .where('classification', 'in', allowed)
    .orderBy('type')
    .orderBy('id')
    .executeTakeFirst();
  if (!node) return { node: null, neighbours: [] };

  const side = async (direction: 'out' | 'in'): Promise<Neighbour[]> => {
    const rows = await db
      .selectFrom('kg_edges as e')
      .innerJoin('kg_nodes as n', 'n.id', direction === 'out' ? 'e.to_id' : 'e.from_id')
      .selectAll('n')
      .select('e.rel')
      .where(direction === 'out' ? 'e.from_id' : 'e.to_id', '=', node.id)
      .where((eb) => eb.or([eb('e.origin', '=', 'curated'), eb('e.approved_by', 'is not', null)]))
      .where('n.status', '=', 'active')
      .where('n.classification', 'in', allowed)
      // Ordered before the cut, so a concept with more than 50 neighbours always keeps the same ones.
      .orderBy('e.rel')
      .orderBy('n.id')
      .limit(50)
      .execute();
    return rows.map((r) => ({ rel: r.rel, direction, node: toNode(r, today) }));
  };
  const neighbours = [...(await side('out')), ...(await side('in'))]
    .sort((a, b) => cmp(a.rel, b.rel) || cmp(a.direction, b.direction) || cmp(a.node.nodeId, b.node.nodeId));
  return { node: toNode(node, today), neighbours };
}
