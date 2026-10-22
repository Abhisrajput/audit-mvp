import { Router } from 'express';
import { z } from 'zod';
import type { AgentConfig } from '../agents/config';
import { actorOf, requireRole } from '../auth/http';
import { READ_ROLES } from '../auth/roles';
import type { Engagement } from '../engine/types';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import { METHODOLOGY_PACK_ID } from '../judgment/standards';
import { logger } from '../observability/log';
import type { AuditService } from '../service';
import { COMMAND_NAMES, commandNamed, commandsFor, withDefaults, type CommandKind, type CommandName } from './commands';
import type { AssistantConfig } from './config';
import { boundInput, LIMITS, ModelPlanner, rulesPlan, type PlannerData, type PlanOutcome } from './planner';

const isEngagement = (v: unknown): v is Engagement =>
  typeof v === 'object' && v !== null && 'testDrafts' in v && 'rcm' in v && 'id' in v;

export const ASSISTANT_TURN_PATH = '/api/assistant/turns';
export const ASSISTANT_COMMAND_PATH = '/api/assistant/commands';

export interface TurnResponse {
  say: string;
  command?: { name: CommandName; kind: CommandKind; args: unknown; summary: string };
  result?: unknown;
  proposal?: { name: CommandName; args: unknown; summary: string; expectedVersion?: number };
}
export interface CommandResponse { summary: string; result: unknown }

const TurnBody = z
  .object({
    message: z.string().trim().min(1).max(LIMITS.message),
    context: z
      .object({
        engagementId: z.string().min(1).max(200).optional(),
        shown: z.array(z.object({ kind: z.enum(['engagement', 'finding', 'document', 'control', 'clause']), id: z.string().min(1).max(200), label: z.string() }).strict()).optional(),
      })
      .strict()
      .optional(),
    history: z.array(z.object({ role: z.enum(['person', 'assistant']), text: z.string() }).strict()).optional(),
  })
  .strict();

const CommandBody = z.object({ name: z.enum(COMMAND_NAMES), args: z.unknown(), expectedVersion: z.number().int().min(1).optional() }).strict();

/** The 404 `svc.engagement` raises for an id that does not exist; a turn answers it in words. */
const isMissingEngagement = (err: unknown) => err instanceof AppError && err.status === 404 && /^Engagement .* not found$/.test(err.message);

/** The chat assistant (spec §7). Mounted under /api, so the session and CSRF gates in app.ts apply. */
export function assistantRoutes(svc: AuditService, deps: { agents: AgentConfig; assistant: AssistantConfig }) {
  const r = Router();
  const readers = requireRole(READ_ROLES);
  const { agents, assistant } = deps;
  const switchedOn = () => {
    if (!assistant.enabled) throw new AppError(503, 'The assistant is switched off (ASSISTANT_ENABLED=false)', 'ASSISTANT_DISABLED');
  };

  r.get('/api/assistant/settings', readers, (req, res) => {
    const role = actorOf(req).role;
    res.json({ enabled: assistant.enabled, planner: svc.llm ? 'llm' : 'rules', commands: commandsFor(role).map(({ name, kind, description }) => ({ name, kind, description })) });
  });

  r.post(ASSISTANT_TURN_PATH, readers, wrap(async (req, res) => {
    switchedOn();
    const actor = actorOf(req);
    const input = boundInput(TurnBody.parse(req.body));
    let planned: { plan: ReturnType<typeof rulesPlan>; outcome: PlanOutcome; detail: string };
    if (svc.llm) {
      const data: PlannerData = {
        engagements: (await svc.listEngagements()).slice(0, 50).map((e) => ({ id: e.id, name: e.name, entity: e.entity, site: e.site, stage: e.stage })),
        packs: svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID).map((p) => ({ id: p.id, name: p.name, vertical: p.vertical })),
        today: new Date().toISOString().slice(0, 10),
      };
      planned = await new ModelPlanner(svc.llm, { model: assistant.model, timeoutMs: assistant.timeoutMs }).plan(input, actor.role, data);
    } else {
      const plan = rulesPlan(input, actor.role);
      planned = { plan, outcome: plan.kind === 'command' ? 'command' : 'reply', detail: 'rules' };
    }
    const { plan } = planned;
    logger.info({ planner: svc.llm ? 'llm' : 'rules', outcome: planned.outcome, ...(plan.kind === 'command' ? { command: plan.command.name } : {}), requestId: req.requestId }, 'assistant turn');
    if (plan.kind === 'reply') {
      const body: TurnResponse = { say: plan.say };
      return res.json(body);
    }
    const { command: cmd, args } = plan;
    const summary = cmd.describe(args);
    const body: TurnResponse = { say: plan.say };
    if (cmd.kind === 'read') {
      body.command = { name: cmd.name, kind: cmd.kind, args, summary };
      try {
        body.result = await cmd.run({ svc, agents, actor }, args, {});
      } catch (err) {
        if (isMissingEngagement(err)) return res.json({ say: `I could not find ${(args as { engagementId?: string }).engagementId}.` } satisfies TurnResponse);
        throw err;
      }
    } else {
      body.proposal = { name: cmd.name, args, summary };
      const engagementId = (args as { engagementId?: unknown } | null)?.engagementId;
      if (cmd.needsEngagement && typeof engagementId === 'string') {
        try {
          body.proposal.expectedVersion = (await svc.engagement(engagementId)).version;
        } catch (err) {
          if (isMissingEngagement(err)) return res.json({ say: `I could not find ${engagementId}.` } satisfies TurnResponse);
          throw err;
        }
      }
    }
    res.json(body);
  }));

  r.post(ASSISTANT_COMMAND_PATH, readers, wrap(async (req, res) => {
    switchedOn();
    const actor = actorOf(req);
    const body = CommandBody.parse(req.body);
    const cmd = commandNamed(body.name)!;
    if (!commandsFor(actor.role).some((c) => c.name === cmd.name)) throw new AppError(403, `${actor.role} may not ${cmd.description}`);
    const args = cmd.args.parse(withDefaults(cmd, body.args, {}));
    // Every engagement write is checked here; the services keep their own checks.
    const engagementId = (args as { engagementId?: unknown } | null)?.engagementId;
    if (cmd.needsEngagement && body.expectedVersion !== undefined && typeof engagementId === 'string') {
      const loaded = await svc.engagement(engagementId);
      if (loaded.version !== body.expectedVersion) {
        throw new AppError(409, `Engagement ${engagementId} is at version ${loaded.version}, not ${body.expectedVersion}; reload and try again`, 'VERSION_CONFLICT');
      }
    }
    const ran = await cmd.run({ svc, agents, actor }, args, { expectedVersion: body.expectedVersion });
    // A command that returns the engagement serves it as this reader may see it (drafts are redacted per reader).
    const result = isEngagement(ran) ? await svc.servedTo(ran, actor) : ran;
    const out: CommandResponse = { summary: cmd.describe(args), result };
    res.json(out);
  }));

  return r;
}
