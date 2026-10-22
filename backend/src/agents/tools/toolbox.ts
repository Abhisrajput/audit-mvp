import type { Kysely } from 'kysely';
import type { DB } from '../../db/schema';
import { appendTrail } from '../../db/trail-repo';
import type { Engagement, User } from '../../engine/types';
import { AppError } from '../../errors';
import type { AgentPort } from '../port';
import { elapsedMs } from '../metrics';
import { appendStep, assertLease, type AgentRun } from '../run-repo';
import { ReadDocumentArgs, readDocument, type DocumentText } from './documents';
import { NeighbourhoodArgs, nodeNeighbourhood, SearchArgs, searchKnowledge, type KnowledgeHit, type Neighbourhood, type ToolName } from './knowledge';

// Which agent may use which tool (spec §5.4), and the one way tools are called. Every call, and every lookup a model
// asked for and was refused, is a lease-fenced tool_call step with its trail entry. Results are recorded by id only,
// so the trail never carries text a reader of the trail might not be allowed to see.

export const TOOL_ALLOW_LIST: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  'test-plan': ['search_knowledge', 'node_neighbourhood'],
  qa: ['search_knowledge', 'node_neighbourhood'],
  evidence: ['search_knowledge', 'read_document'],
});

export const mayUse = (agent: string, tool: string): boolean => (TOOL_ALLOW_LIST[agent] ?? []).some((t) => t === tool);

export interface ToolboxContext {
  db: Kysely<DB>;
  port: AgentPort;
  /** A run this worker leases: every record is fenced on its lease. */
  run: AgentRun;
  /** Tools see only what this person may see. */
  starter: User;
  engagement: Engagement;
}

/** A lookup a model asked for. Nothing about it is trusted until it is checked. */
export interface LookupRequest {
  tool: string;
  args: unknown;
}

export interface LookupResult {
  tool: string;
  args: unknown;
  result?: unknown;
  refused?: string;
}

/** How much of a refused lookup's raw arguments is kept: the trail is permanent, and a model's output is not bounded. */
export const MAX_REFUSED_ARGS_CHARS = 500;

const rawArgs = (args: unknown): string => (JSON.stringify(args ?? null) ?? String(args)).slice(0, MAX_REFUSED_ARGS_CHARS);

const idsOf = (result: KnowledgeHit[] | Neighbourhood | DocumentText): string[] => {
  if (Array.isArray(result)) return result.map((h) => h.id);
  if ('documentId' in result) return [result.documentId];
  return [...(result.node ? [result.node.nodeId] : []), ...result.neighbours.map((n) => n.node.nodeId)];
};

const ARG_PARSERS = { search_knowledge: SearchArgs, node_neighbourhood: NeighbourhoodArgs, read_document: ReadDocumentArgs } as const;

export class Toolbox {
  constructor(private readonly ctx: ToolboxContext, readonly agent: string) {}

  /**
   * Calls a tool for this agent. A tool off the agent's allow-list is refused with AGENT_FORBIDDEN: only our own code
   * calls this, so that would be a bug, and the run stops for a person.
   */
  async call(tool: ToolName, args: unknown): Promise<KnowledgeHit[] | Neighbourhood | DocumentText> {
    if (!mayUse(this.agent, tool)) throw new AppError(403, `The ${this.agent} agent may not use ${tool}`, 'AGENT_FORBIDDEN');
    const started = Date.now();
    const { db, starter, engagement } = this.ctx;
    let parsed: unknown;
    let result: KnowledgeHit[] | Neighbourhood | DocumentText;
    if (tool === 'search_knowledge') {
      const a = SearchArgs.parse(args);
      parsed = a;
      // The evidence agent reads evidence only: the scope is the toolbox's, never the model's.
      result = await searchKnowledge(db, starter, engagement.id, a, this.agent === 'evidence' ? { kinds: ['evidence'] } : undefined);
    } else if (tool === 'read_document') {
      const a = ReadDocumentArgs.parse(args);
      parsed = a;
      result = await readDocument(db, starter, engagement.id, a);
    } else {
      const a = NeighbourhoodArgs.parse(args);
      parsed = a;
      result = await nodeNeighbourhood(db, starter, a);
    }
    // The arguments the tool ran with, as parsed: bounded by the tool's schema.
    await this.record({ tool, args: parsed, resultIds: idsOf(result) }, elapsedMs(started));
    return result;
  }

  /**
   * Lookups a model asked for, at most `max` of them. Each is checked against the allow-list and its tool's arguments
   * before anything runs. A refused one is logged and skipped: like an answer off the menu, it does not stop the run.
   */
  async lookups(requests: LookupRequest[], max = 3): Promise<LookupResult[]> {
    const out: LookupResult[] = [];
    for (const r of requests.slice(0, max)) {
      if (!mayUse(this.agent, r.tool)) {
        // The tool's name came from the model too, so it is bounded like its arguments.
        const name = r.tool.slice(0, 100);
        const refused = `${name} is not on the ${this.agent} agent's allow-list`;
        await this.record({ tool: name, args: rawArgs(r.args), resultIds: [], refused });
        out.push({ ...r, refused });
        continue;
      }
      const tool = r.tool as ToolName;
      const parsed = ARG_PARSERS[tool].safeParse(r.args);
      if (!parsed.success) {
        const refused = `the arguments for ${tool} were not valid`;
        await this.record({ tool, args: rawArgs(r.args), resultIds: [], refused });
        out.push({ ...r, refused });
        continue;
      }
      out.push({ ...r, result: await this.call(tool, parsed.data) });
    }
    return out;
  }

  private async record(output: { tool: string; args: unknown; resultIds: string[]; refused?: string }, durationMs = 0) {
    const { db, port, run, starter, engagement } = this.ctx;
    await db.transaction().execute(async (trx) => {
      await assertLease(trx, run.id, run.leaseOwner!);
      const sealed = await appendTrail(trx, port.agentBundle(engagement, {
        moduleId: 'agent:tool', agent: this.agent, runId: run.id, onBehalfOf: starter.id, inputs: { tool: output.tool, args: output.args }, output,
      }));
      await appendStep(trx, run.id, { kind: 'tool_call', agent: this.agent, decision: output, durationMs, trailBundleId: sealed.id });
    });
  }
}
