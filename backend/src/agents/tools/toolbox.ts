import type { Kysely } from 'kysely';
import type { DB } from '../../db/schema';
import { appendTrail } from '../../db/trail-repo';
import type { Engagement, User } from '../../engine/types';
import { AppError } from '../../errors';
import type { AgentPort } from '../port';
import { appendStep, assertLease, type AgentRun } from '../run-repo';
import { NeighbourhoodArgs, nodeNeighbourhood, SearchArgs, searchKnowledge, type KnowledgeHit, type Neighbourhood, type ToolName } from './knowledge';

// Which agent may use which tool (spec §5.4), and the one way tools are called. Every call, and every lookup a model
// asked for and was refused, is a lease-fenced tool_call step with its trail entry. Results are recorded by id only,
// so the trail never carries text a reader of the trail might not be allowed to see.

export const TOOL_ALLOW_LIST: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  'test-plan': ['search_knowledge', 'node_neighbourhood'],
  qa: ['search_knowledge', 'node_neighbourhood'],
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

const idsOf = (result: KnowledgeHit[] | Neighbourhood): string[] =>
  Array.isArray(result) ? result.map((h) => h.id) : [...(result.node ? [result.node.nodeId] : []), ...result.neighbours.map((n) => n.node.nodeId)];

export class Toolbox {
  constructor(private readonly ctx: ToolboxContext, readonly agent: string) {}

  /**
   * Calls a tool for this agent. A tool off the agent's allow-list is refused with AGENT_FORBIDDEN: only our own code
   * calls this, so that would be a bug, and the run stops for a person.
   */
  async call(tool: ToolName, args: unknown): Promise<KnowledgeHit[] | Neighbourhood> {
    if (!mayUse(this.agent, tool)) throw new AppError(403, `The ${this.agent} agent may not use ${tool}`, 'AGENT_FORBIDDEN');
    const { db, starter, engagement } = this.ctx;
    const result = tool === 'search_knowledge'
      ? await searchKnowledge(db, starter, engagement.id, SearchArgs.parse(args))
      : await nodeNeighbourhood(db, starter, NeighbourhoodArgs.parse(args));
    await this.record({ tool, args, resultIds: idsOf(result) });
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
        const refused = `${r.tool} is not on the ${this.agent} agent's allow-list`;
        await this.record({ tool: r.tool, args: r.args, resultIds: [], refused });
        out.push({ ...r, refused });
        continue;
      }
      const tool = r.tool as ToolName;
      const parsed = (tool === 'search_knowledge' ? SearchArgs : NeighbourhoodArgs).safeParse(r.args);
      if (!parsed.success) {
        const refused = `the arguments for ${tool} were not valid`;
        await this.record({ tool, args: r.args, resultIds: [], refused });
        out.push({ ...r, refused });
        continue;
      }
      out.push({ ...r, result: await this.call(tool, parsed.data) });
    }
    return out;
  }

  private async record(output: { tool: string; args: unknown; resultIds: string[]; refused?: string }) {
    const { db, port, run, starter, engagement } = this.ctx;
    await db.transaction().execute(async (trx) => {
      await assertLease(trx, run.id, run.leaseOwner!);
      const sealed = await appendTrail(trx, port.agentBundle(engagement, {
        moduleId: 'agent:tool', agent: this.agent, runId: run.id, onBehalfOf: starter.id, inputs: { tool: output.tool, args: output.args }, output,
      }));
      await appendStep(trx, run.id, { kind: 'tool_call', agent: this.agent, decision: output, trailBundleId: sealed.id });
    });
  }
}
