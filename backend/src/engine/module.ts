import type { Bm25Index } from './grounding';
import type { LlmProvider } from './llm/provider';
import type { PackRegistry } from './packs';
import type { CitationPolicy } from './trust';
import type { Engagement, LogEntry, QaAction, RetrievalHit, User } from './types';

export interface Grounding {
  clauses: Bm25Index;
  controls: Bm25Index;
}

/** Everything a module may touch during one execution. Every side channel is recorded. */
export class ModuleContext {
  readonly log: LogEntry[] = [];
  readonly qa: QaAction[] = [];
  readonly retrievalSet: RetrievalHit[] = [];
  promptHash: string | null = null;
  servedModel: string | null = null;

  constructor(
    readonly engagement: Engagement,
    readonly registry: PackRegistry,
    readonly grounding: Grounding,
    readonly llm: LlmProvider | null,
    readonly actor: User,
    readonly input: Record<string, unknown>,
    readonly policy: CitationPolicy,
  ) {}

  step(step: string, detail: string) {
    this.log.push({ at: new Date().toISOString(), step, detail });
  }

  gate(...actions: QaAction[]) {
    this.qa.push(...actions);
  }

  /** Clause retrieval restricted to the engagement's packs; hits go into the trail. */
  retrieveClauses(query: string, k = 8): RetrievalHit[] {
    const allowed = new Set(this.registry.clausesFor(this.engagement.packIds).map((c) => c.id));
    const hits = this.grounding.clauses.search(query, k, (id) => allowed.has(id));
    for (const h of hits) {
      if (!this.retrievalSet.some((r) => r.clauseId === h.clauseId)) this.retrievalSet.push(h);
    }
    this.step('retrieve', `"${query.slice(0, 80)}" -> ${hits.map((h) => h.clauseId).join(', ') || 'no hits'}`);
    return hits;
  }
}

export interface AuditModule<Output> {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Returns a reason string when the module cannot run yet (the chain order). */
  precondition(e: Engagement): string | null;
  run(ctx: ModuleContext): Promise<Output>;
  /** Writes the gated output into the engagement's working state. */
  apply(e: Engagement, output: Output, bundleId: string): void;
}
