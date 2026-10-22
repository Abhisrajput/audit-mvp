import { z } from 'zod';
import type { AgentConfig } from '../agents/config';
import { listGates } from '../agents/gate-repo';
import { listRuns } from '../agents/run-repo';
import { startRun } from '../agents/runs';
import type { GateKind, RunStatus } from '../agents/types';
import { PREPARER_ROLES, READ_ROLES } from '../auth/roles';
import type { Engagement, EngagementStage, FindingStatus, Opinion, ResponseKind, RiskRating, Role, User } from '../engine/types';
import { NewEngagementSchema, ResponseInputSchema, searchClauses, ToleranceSchema } from '../http/schemas';
import { EngagementContextInputSchema } from '../judgment/context';
import { METHODOLOGY_PACK_ID } from '../judgment/standards';
import { CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, type DocumentKind } from '../knowledge/access';
import { getDocument, listDocuments } from '../knowledge/document-repo';
import { PgFtsRetriever } from '../knowledge/retriever';
import type { AuditService, MutationOptions } from '../service';

// The assistant's whole vocabulary (spec §3): each command wraps a service method the UI already calls, parses its
// arguments with the routes' own schemas, and so can do nothing a person could not do from the same screens.
// There is deliberately no command that signs, approves or rejects, or that acts as the agent.

export const COMMAND_NAMES = ['list_engagements', 'show_engagement', 'list_findings', 'find_documents', 'search_standards', 'list_packs',
  'create_engagement', 'set_context', 'start_run', 'set_tolerance', 'record_management_response'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type CommandKind = 'read' | 'write';

export interface CommandContext { svc: AuditService; agents: AgentConfig; actor: User }

export interface Command<A = any> {
  name: CommandName; kind: CommandKind; roles: readonly Role[]; description: string;
  /** Strict zod object; what the planner is shown (as JSON schema) and what every call is parsed with. */
  args: z.ZodObject<any>;
  /** The command takes an engagementId that defaults from the panel's context when absent. */
  needsEngagement: boolean;
  run(ctx: CommandContext, args: A, opts: MutationOptions): Promise<unknown>;
  describe(args: A): string;
}

export interface EngagementCard {
  id: string; name: string; entity: string; site: string; periodFrom: string; periodTo: string; stage: EngagementStage; packIds: string[];
  counts: { scopeIncluded: number; rcmRows: number; findings: Record<FindingStatus, number> }; opinion: Opinion | null; openGate: GateKind | null;
  run: { status: RunStatus; statusReason: string } | null; version: number;
}
export interface FindingRow { id: string; title: string; rating: RiskRating; status: FindingStatus; response: ResponseKind | null }
export type DocumentResult =
  | { kind: 'document'; id: string; filename: string; documentKind: DocumentKind; snippet: string; href: string }
  | { kind: 'concept'; conceptId: string; packId: string; title: string; snippet: string };
export interface ClauseResult { id: string; title: string; regulation: string; ref: string; summary: string }
export interface PackRow { id: string; name: string; version: string; vertical: string }

const engagementId = z.string().min(1);
const contentHref = (id: string) => `/api/documents/${id}/content`;
const FINDING_STATUSES: readonly FindingStatus[] = ['draft', 'blocked', 'reviewed', 'approved', 'rejected'];

/** EngagementContextInputSchema is typed z.ZodType but is a z.object of exactly `factors` and `background`. */
const contextShape = (EngagementContextInputSchema as unknown as z.ZodObject<any>).shape;
const ContextArgs = z.object({ engagementId, factors: contextShape.factors, background: contextShape.background }).strict();

const RESPONSE_WORDS: Record<ResponseKind, string> = { agree: 'agrees', partially_agree: 'partially agrees', disagree: 'disagrees' };
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

async function card(svc: AuditService, id: string): Promise<EngagementCard> {
  const e = await svc.engagement(id);
  const [gates, runs] = await Promise.all([listGates(svc.db.kysely, id), listRuns(svc.db.kysely, id)]);
  const findings = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
  for (const f of e.findings) findings[f.status]++;
  return {
    id: e.id, name: e.name, entity: e.entity, site: e.site, periodFrom: e.periodFrom, periodTo: e.periodTo, stage: e.stage, packIds: e.packIds,
    counts: { scopeIncluded: e.scope.filter((s) => s.included).length, rcmRows: e.rcm.length, findings },
    opinion: e.report?.opinion?.rating ?? null,
    openGate: gates.find((g) => g.state === 'open')?.kind ?? null,
    run: runs[0] ? { status: runs[0].status, statusReason: runs[0].statusReason } : null,
    version: e.version ?? 0,
  };
}

async function findDocuments(ctx: CommandContext, a: { query?: string; engagementId?: string; kinds?: DocumentKind[] }): Promise<DocumentResult[]> {
  const db = ctx.svc.db.kysely;
  if (a.query) {
    const hits = await new PgFtsRetriever(db).search(a.query, { user: ctx.actor, engagementId: a.engagementId, kinds: a.kinds, limit: 10 });
    // A chunk hit does not carry its document's kind; the hit is already access-checked, so the lookup only labels it.
    return Promise.all(hits.map(async (h): Promise<DocumentResult> => {
      if (h.kind === 'kg_node') return { kind: 'concept', conceptId: h.citation.conceptId, packId: h.citation.packId, title: h.title, snippet: h.snippet };
      const doc = await getDocument(db, h.citation.documentId);
      return { kind: 'document', id: h.citation.documentId, filename: h.citation.filename, documentKind: doc?.kind ?? 'other', snippet: h.snippet, href: contentHref(h.citation.documentId) };
    }));
  }
  const docs = await listDocuments(db, { engagementId: a.engagementId ?? null, classifications: CLASSIFICATIONS_BY_ROLE[ctx.actor.role] });
  return docs.reverse().slice(0, 20).map((d) => ({ kind: 'document', id: d.id, filename: d.filename, documentKind: d.kind, snippet: '', href: contentHref(d.id) }));
}

const none = z.object({}).strict();

export const COMMANDS: readonly Command[] = [
  {
    name: 'list_engagements', kind: 'read', roles: READ_ROLES, description: 'List the engagements', args: none, needsEngagement: false,
    run: (ctx) => ctx.svc.listEngagements(),
    describe: () => 'List engagements',
  },
  {
    name: 'show_engagement', kind: 'read', roles: READ_ROLES, description: 'Show one engagement: stage, counts, opinion, open gate and latest run',
    args: z.object({ engagementId }).strict(), needsEngagement: true,
    run: (ctx, a: { engagementId: string }) => card(ctx.svc, a.engagementId),
    describe: (a: { engagementId: string }) => `Show engagement ${a.engagementId}`,
  },
  {
    name: 'list_findings', kind: 'read', roles: READ_ROLES, description: 'List the findings of an engagement',
    args: z.object({ engagementId }).strict(), needsEngagement: true,
    run: async (ctx, a: { engagementId: string }): Promise<FindingRow[]> => {
      const e: Engagement = await ctx.svc.engagement(a.engagementId);
      return e.findings.map((f) => ({ id: f.id, title: f.title, rating: f.rating, status: f.status, response: e.responses[f.id]?.response ?? null }));
    },
    describe: (a: { engagementId: string }) => `List findings of ${a.engagementId}`,
  },
  {
    name: 'find_documents', kind: 'read', roles: READ_ROLES, description: 'Find documents and evidence in the library or on an engagement by words in their text',
    args: z.object({ query: z.string().trim().min(1).max(200).optional(), engagementId: engagementId.optional(), kinds: z.array(z.enum(DOCUMENT_KINDS)).optional() }).strict(),
    needsEngagement: true,
    run: (ctx, a) => findDocuments(ctx, a),
    describe: (a: { query?: string }) => (a.query ? `Find documents about "${a.query}"` : 'List documents'),
  },
  {
    name: 'search_standards', kind: 'read', roles: READ_ROLES, description: 'Search the standards and regulations in the content packs',
    args: z.object({ query: z.string().trim().min(1).max(200), packIds: z.array(z.string()).optional() }).strict(), needsEngagement: false,
    run: async (ctx, a: { query: string; packIds?: string[] }): Promise<ClauseResult[]> =>
      searchClauses(ctx.svc, a.query, a.packIds).flatMap((h) => (h.clause ? [{ id: h.clause.id, title: h.clause.title, regulation: h.clause.regulation, ref: h.clause.ref, summary: h.clause.summary }] : [])),
    describe: (a: { query: string }) => `Search standards for "${a.query}"`,
  },
  {
    name: 'list_packs', kind: 'read', roles: READ_ROLES, description: 'List the content packs', args: none, needsEngagement: false,
    run: async (ctx): Promise<PackRow[]> =>
      ctx.svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID).map((p) => ({ id: p.id, name: p.name, version: p.version, vertical: p.vertical })),
    describe: () => 'List content packs',
  },
  {
    name: 'create_engagement', kind: 'write', roles: PREPARER_ROLES, description: 'Create a new engagement',
    args: NewEngagementSchema.omit({ context: true }).strict(), needsEngagement: false,
    run: (ctx, a: z.infer<typeof NewEngagementSchema>) => ctx.svc.createEngagement(a, ctx.actor),
    describe: (a: z.infer<typeof NewEngagementSchema>) =>
      `Create engagement "${a.name}" for ${a.entity} at ${a.site}, ${a.periodFrom} to ${a.periodTo}, packs ${a.packIds.join(', ')}`,
  },
  {
    name: 'set_context', kind: 'write', roles: PREPARER_ROLES, description: 'Set the context of an engagement: background and risk factors',
    args: ContextArgs, needsEngagement: true,
    run: (ctx, a: z.infer<typeof ContextArgs>, opts) => ctx.svc.setEngagementContext(a.engagementId, { factors: a.factors, background: a.background }, ctx.actor, opts),
    describe: (a: z.infer<typeof ContextArgs>) =>
      `Set the context of ${a.engagementId}: ${a.factors.length} factor(s), background "${String(a.background).slice(0, 60)}"`,
  },
  {
    name: 'start_run', kind: 'write', roles: PREPARER_ROLES, description: 'Start an agent run on an engagement',
    args: z.object({ engagementId }).strict(), needsEngagement: true,
    run: (ctx, a: { engagementId: string }) => startRun(ctx.svc, ctx.agents, a.engagementId, ctx.actor),
    describe: (a: { engagementId: string }) => `Start an agent run on ${a.engagementId}`,
  },
  {
    name: 'set_tolerance', kind: 'write', roles: PREPARER_ROLES, description: 'Set the tolerance rate of a control on an engagement',
    args: z.object({ engagementId, controlId: z.string().min(1), rate: ToleranceSchema.shape.rate }).strict(), needsEngagement: true,
    run: (ctx, a: { engagementId: string; controlId: string; rate: number }, opts) => ctx.svc.setTolerance(a.engagementId, a.controlId, a.rate, ctx.actor, opts),
    describe: (a: { engagementId: string; controlId: string; rate: number }) => `Set the tolerance of ${a.controlId} on ${a.engagementId} to ${percent(a.rate)}`,
  },
  {
    name: 'record_management_response', kind: 'write', roles: PREPARER_ROLES, description: "Record management's response to an approved finding",
    args: ResponseInputSchema.extend({ engagementId, findingId: z.string().min(1) }).strict(), needsEngagement: true,
    run: (ctx, { engagementId: id, findingId, ...input }: z.infer<typeof ResponseInputSchema> & { engagementId: string; findingId: string }, opts) =>
      ctx.svc.recordManagementResponse(id, findingId, input, ctx.actor, opts),
    describe: (a: z.infer<typeof ResponseInputSchema> & { engagementId: string; findingId: string }) =>
      `Record that management ${RESPONSE_WORDS[a.response]} with ${a.findingId} on ${a.engagementId}, owner ${a.owner}${typeof a.dueDate === 'string' ? `, due ${a.dueDate}` : ''}`,
  },
];

export const commandsFor = (role: Role): Command[] => COMMANDS.filter((c) => c.roles.includes(role));
export const commandNamed = (name: string): Command | undefined => COMMANDS.find((c) => c.name === name);

/** Copies the panel's engagement into the arguments when the command takes one and the planner left it out. */
export function withDefaults(cmd: Command, args: unknown, context: { engagementId?: string }): unknown {
  if (!cmd.needsEngagement || !context.engagementId) return args;
  const given = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return given.engagementId === undefined ? { ...given, engagementId: context.engagementId } : args;
}

export const describeCommand = (name: CommandName, args: unknown): string => commandNamed(name)!.describe(args);
