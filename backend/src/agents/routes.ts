import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { READ_ROLES } from '../auth/roles';
import { AppError } from '../errors';
import { ifMatch, wrap } from '../http-util';
import { renderMemo } from '../judgment/memo';
import type { AuditService } from '../service';
import type { AgentConfig } from './config';
import { listGates } from './gate-repo';
import { getRun, listRuns, listSteps } from './run-repo';
import { cancelRun, pauseRun, raiseBudget, resumeRun, startRun } from './runs';

const BudgetSchema = z.object({ maxSteps: z.number().int().positive(), maxTokens: z.number().int().positive(), maxCostUsd: z.number().positive() }).strict();

const TestPlanPatchSchema = z
  .object({
    attribute: z.string().min(1),
    population: z.string().min(1),
    sampleSize: z.number().int().min(0),
    selectionMethod: z.enum(['random', 'all', 'judgemental']),
    evidenceToRequest: z.array(z.string().min(1)),
    procedure: z.string().min(1),
    notTestedJustification: z.string().max(2000),
  })
  .partial()
  .strict();

/** Agent runs, gates and test plans (spec §7.1). Mounted under /api, so the session, CSRF and role gates in app.ts apply. */
export function agentRoutes(svc: AuditService, cfg: AgentConfig) {
  const r = Router();
  const readers = requireRole(READ_ROLES);
  const param = (req: Request, name: string) => String(req.params[name]);

  // What the UI needs before it offers a run (agent spec §7.2): whether runs can start, the budget a starter may lower,
  // the QA threshold it shows signers, and how the worker decides.
  r.get('/api/agents/settings', readers, (_req, res) => {
    res.json({ enabled: cfg.enabled, budget: cfg.budget, qaThreshold: cfg.qaThreshold, policy: svc.llm ? 'llm' : 'rules' });
  });

  r.post('/api/engagements/:id/runs', readers, wrap(async (req, res) => {
    const body = z.object({ budget: BudgetSchema.partial().optional() }).strict().parse(req.body ?? {});
    res.status(201).json(await startRun(svc, cfg, param(req, 'id'), actorOf(req), body.budget));
  }));

  r.get('/api/engagements/:id/runs', readers, wrap(async (req, res) => {
    await svc.engagement(param(req, 'id'));
    res.json(await listRuns(svc.db.kysely, param(req, 'id')));
  }));

  r.get('/api/runs/:runId', readers, wrap(async (req, res) => {
    const run = await getRun(svc.db.kysely, param(req, 'runId'));
    if (!run) throw new AppError(404, 'Agent run not found');
    const page = z.object({ afterSeq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    res.json({ run, steps: await listSteps(svc.db.kysely, run.id, page) });
  }));

  r.post('/api/runs/:runId/pause', readers, wrap(async (req, res) => res.json(await pauseRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/resume', readers, wrap(async (req, res) => res.json(await resumeRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/cancel', readers, wrap(async (req, res) => res.json(await cancelRun(svc, param(req, 'runId'), actorOf(req)))));
  r.post('/api/runs/:runId/budget', readers, wrap(async (req, res) => {
    res.json(await raiseBudget(svc, param(req, 'runId'), actorOf(req), BudgetSchema.parse(req.body)));
  }));

  r.get('/api/engagements/:id/gates', readers, wrap(async (req, res) => {
    await svc.engagement(param(req, 'id'));
    res.json(await listGates(svc.db.kysely, param(req, 'id')));
  }));

  // The judgment memo for a subject (e.g. 'scope'), as data and as the markdown the panel shows.
  r.get('/api/engagements/:id/memos/:subjectKey', readers, wrap(async (req, res) => {
    const key = param(req, 'subjectKey');
    const memos = (await svc.engagement(param(req, 'id'))).memos;
    // Own keys only: a key such as `constructor` must be a 404, not an inherited object.
    const memo = Object.hasOwn(memos, key) ? memos[key] : undefined;
    if (!memo) throw new AppError(404, `No memo for ${key}`);
    res.json({ memo, markdown: renderMemo(memo) });
  }));

  r.get('/api/engagements/:id/test-plans', readers, wrap(async (req, res) => res.json((await svc.engagement(param(req, 'id'))).testPlans)));
  r.put('/api/engagements/:id/test-plans/:rowId', readers, wrap(async (req, res) => {
    res.json(await svc.editTestPlan(param(req, 'id'), param(req, 'rowId'), TestPlanPatchSchema.parse(req.body), actorOf(req), ifMatch(req)));
  }));

  return r;
}
