import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema';
import type { User } from '../engine/types';
import { CLASSIFICATIONS_BY_ROLE, type DocumentKind } from './access';

export interface RetrievalScope {
  user: User;
  /** Search this engagement's documents as well as global ones; omit for global documents only. */
  engagementId?: string;
  kinds?: readonly DocumentKind[];
  limit?: number;
}

export interface DocumentCitation {
  documentId: string;
  filename: string;
  page: number | null;
  chunkOrdinal: number;
}

export interface Hit {
  id: string;
  /** 'kg_node' hits arrive with the knowledge graph (plan 1E). */
  kind: 'chunk' | 'kg_node';
  title: string;
  snippet: string;
  score: number;
  citation: DocumentCitation;
  /** Whether a finding may cite this hit; plan 1E applies trust rules to knowledge-graph nodes. */
  citable: boolean;
}

export interface Retriever {
  search(query: string, scope: RetrievalScope): Promise<Hit[]>;
}

export const MAX_HITS = 50;

/**
 * Postgres full-text search over chunks. Permission filtering happens inside the
 * query, so text a user may not read never leaves the database — not even in a snippet.
 */
export class PgFtsRetriever implements Retriever {
  constructor(private readonly db: Kysely<DB>) {}

  async search(query: string, scope: RetrievalScope): Promise<Hit[]> {
    const allowed = CLASSIFICATIONS_BY_ROLE[scope.user.role];
    if (!query.trim() || !allowed.length) return [];
    const limit = Math.min(Math.max(scope.limit ?? 10, 1), MAX_HITS);
    const engagementFilter = scope.engagementId
      ? sql`(c.engagement_id IS NULL OR c.engagement_id = ${scope.engagementId})`
      : sql`c.engagement_id IS NULL`;
    const kindFilter = scope.kinds?.length ? sql`AND d.kind IN (${sql.join([...scope.kinds])})` : sql``;

    const { rows } = await sql<{ id: string; document_id: string; ordinal: number; page: number | null; filename: string; score: number; snippet: string }>`
      SELECT c.id, c.document_id, c.ordinal, c.page, d.filename,
             ts_rank(c.tsv, q) AS score,
             ts_headline('english', c.text, q, 'MaxWords=35, MinWords=12, ShortWord=3') AS snippet
      FROM chunks c
      JOIN documents d ON d.id = c.document_id,
           websearch_to_tsquery('english', ${query}) q
      WHERE c.tsv @@ q
        AND c.classification IN (${sql.join([...allowed])})
        AND ${engagementFilter}
        AND d.retention_expired = false
        ${kindFilter}
      ORDER BY score DESC, c.id
      LIMIT ${limit}`.execute(this.db);

    return rows.map((r) => ({
      id: r.id, kind: 'chunk', title: r.filename, snippet: r.snippet, score: Number(r.score), citable: true,
      citation: { documentId: r.document_id, filename: r.filename, page: r.page, chunkOrdinal: r.ordinal },
    }));
  }
}
