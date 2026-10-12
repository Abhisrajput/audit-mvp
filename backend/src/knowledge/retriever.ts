import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema';
import type { User } from '../engine/types';
import { todayUtc, trustProblems, type TrustProblem } from '../engine/trust';
import { CLASSIFICATIONS_BY_ROLE, type DocumentKind } from './access';

export interface RetrievalScope {
  user: User;
  /** Search this engagement's documents as well as global ones; omit for global documents only. */
  engagementId?: string;
  /** Document kinds to search; 'okf_concept' also selects knowledge-graph nodes. Omit to search all documents and nodes. */
  kinds?: readonly DocumentKind[];
  limit?: number;
}

export interface DocumentCitation {
  documentId: string;
  filename: string;
  page: number | null;
  chunkOrdinal: number;
}

export interface NodeCitation {
  /** Knowledge-graph node, e.g. "pharma/clause/21cfr211-22". */
  nodeId: string;
  /** The id findings cite, e.g. "21CFR211.22". */
  conceptId: string;
  packId: string;
  packVersion: string;
  /** Bundle file, e.g. "pharma/clauses/21cfr211-22.md". */
  sourcePath: string;
  chunkOrdinal: number;
}

interface HitBase {
  id: string;
  title: string;
  snippet: string;
  score: number;
  /** Whether a finding may cite this hit (knowledge-graph nodes: the trust rules, spec §6.4). */
  citable: boolean;
}
export interface DocumentHit extends HitBase {
  kind: 'chunk';
  citation: DocumentCitation;
}
export interface NodeHit extends HitBase {
  kind: 'kg_node';
  citation: NodeCitation;
  /** Why the node is not citable; empty when it is. */
  trustProblems: TrustProblem[];
}
export type Hit = DocumentHit | NodeHit;

export interface Retriever {
  search(query: string, scope: RetrievalScope): Promise<Hit[]>;
}

export const MAX_HITS = 50;

/**
 * Postgres full-text search over document chunks and knowledge-graph chunks. Permission filtering
 * happens inside the query, so text a user may not read never leaves the database, not even in a
 * snippet. Documents are checked against their documents row (classification, engagement, retention);
 * knowledge-graph nodes against their kg_nodes row (classification, active).
 */
export class PgFtsRetriever implements Retriever {
  constructor(private readonly db: Kysely<DB>) {}

  async search(query: string, scope: RetrievalScope): Promise<Hit[]> {
    const allowed = CLASSIFICATIONS_BY_ROLE[scope.user.role];
    if (!query.trim() || !allowed.length) return [];
    const limit = Math.min(Math.max(scope.limit ?? 10, 1), MAX_HITS);
    // The documents row is authoritative; the chunk's copies (which the index uses) must agree too,
    // so a stale copy can only hide a chunk, never reveal one.
    const inScope = (column: ReturnType<typeof sql.ref>) =>
      scope.engagementId ? sql`(${column} IS NULL OR ${column} = ${scope.engagementId})` : sql`${column} IS NULL`;
    const classes = sql.join([...allowed]);
    const kinds = scope.kinds?.length ? scope.kinds : null;
    const docKinds = kinds ? sql`AND d.kind IN (${sql.join([...kinds])})` : sql``;
    const nodeKinds = kinds && !kinds.includes('okf_concept') ? sql`AND false` : sql``;

    const { rows } = await sql<{
      id: string; document_id: string | null; kg_node_id: string | null; ordinal: number; page: number | null; filename: string | null;
      node_title: string | null; concept_id: string | null; pack_id: string | null; pack_version: string | null; source_path: string | null;
      verified_by: string | null; verified_role: string | null; verified_at: string | null; node_status: 'active' | 'deprecated' | null;
      stale_after: string | null; score: number; snippet: string;
    }>`
      SELECT c.id, c.document_id, c.kg_node_id, c.ordinal, c.page, d.filename,
             n.title AS node_title, n.concept_id, n.pack_id, n.pack_version, n.source_path,
             n.verified_by, n.verified_role, n.verified_at, n.status AS node_status, n.stale_after,
             ts_rank(c.tsv, q) AS score,
             ts_headline('english', c.text, q, 'MaxWords=35, MinWords=12, ShortWord=3') AS snippet
      FROM chunks c
      LEFT JOIN documents d ON d.id = c.document_id
      LEFT JOIN kg_nodes n ON n.id = c.kg_node_id,
           websearch_to_tsquery('english', ${query}) q
      WHERE c.tsv @@ q
        AND c.classification IN (${classes})
        AND ${inScope(sql.ref('c.engagement_id'))}
        AND (
              (d.id IS NOT NULL AND d.classification IN (${classes}) AND ${inScope(sql.ref('d.engagement_id'))}
                AND d.retention_expired = false ${docKinds})
           OR (n.id IS NOT NULL AND n.status = 'active' AND n.classification IN (${classes}) ${nodeKinds})
        )
      ORDER BY score DESC, c.id
      LIMIT ${limit}`.execute(this.db);

    const today = todayUtc();
    return rows.map((r): Hit => {
      if (r.kg_node_id) {
        const problems = trustProblems({
          nodeId: r.kg_node_id, verifiedBy: r.verified_by, verifiedRole: r.verified_role, verifiedAt: r.verified_at,
          status: r.node_status!, staleAfter: r.stale_after, sourcePath: r.source_path!,
        }, today);
        return {
          id: r.id, kind: 'kg_node', title: `${r.concept_id} — ${r.node_title}`, snippet: r.snippet, score: Number(r.score),
          citable: problems.length === 0, trustProblems: problems,
          citation: { nodeId: r.kg_node_id, conceptId: r.concept_id!, packId: r.pack_id!, packVersion: r.pack_version!, sourcePath: r.source_path!, chunkOrdinal: r.ordinal },
        };
      }
      return {
        id: r.id, kind: 'chunk', title: r.filename!, snippet: r.snippet, score: Number(r.score), citable: true,
        citation: { documentId: r.document_id!, filename: r.filename!, page: r.page, chunkOrdinal: r.ordinal },
      };
    });
  }
}
