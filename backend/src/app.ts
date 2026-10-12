import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminRoutes } from './auth/admin-routes';
import { actorOf, requireRole, requireUser, sessionMiddleware } from './auth/http';
import { PREPARER_ROLES, READ_ROLES } from './auth/roles';
import { authRoutes, type AuthDeps } from './auth/routes';
import { evalMarkdown, runEval } from './eval/harness';
import { wrap } from './http-util';
import { AppError, AuditService, type MutationOptions } from './service';
import { buildTraceability } from './validation/traceability';

const NewEngagementSchema = z.object({
  name: z.string().min(1),
  entity: z.string().min(1),
  site: z.string().min(1),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
  auditType: z.string().min(1),
  scopeStatement: z.string().min(1),
  packIds: z.array(z.string()).min(1),
});

const TestInputSchema = z.object({
  designAdequate: z.boolean().nullable(),
  observation: z.string(),
  evidenceRefs: z.array(z.string().min(1)),
  sampleTested: z.number().int().min(0),
  exceptions: z.number().int().min(0),
});

const FindingPatchSchema = z
  .object({
    title: z.string().min(1),
    rating: z.enum(['High', 'Medium', 'Low']),
    condition: z.string().min(1),
    criteria: z.string().min(1),
    cause: z.string().min(1),
    effect: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .partial();

export function createApp(svc: AuditService, auth: AuthDeps) {
  const app = express();
  // Same-origin only: the UI is served behind the same host (nginx or the Vite proxy), so no CORS.
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(svc.db.kysely, auth.config));

  const param = (req: Request, name: string) => String(req.params[name]);

  /** `If-Match: "<version>"` opts a change into the optimistic-concurrency check. */
  const mutation = (req: Request): MutationOptions => {
    const header = req.header('if-match');
    if (header === undefined) return {};
    const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'If-Match must be the engagement version number');
    return { expectedVersion: version };
  };

  // ----- Public -----
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: svc.providerInfo }));
  app.use(authRoutes(svc.db, auth));

  // ----- Everything below needs a signed-in user with a role (and CSRF on changes) -----
  app.use('/api', requireUser());
  const readers = requireRole(READ_ROLES);
  const evaluators = requireRole([...PREPARER_ROLES, 'cae']);
  app.use(adminRoutes(svc.db, auth.config));

  app.get('/api/modules', readers, (_req, res) => res.json(svc.modules()));

  // ----- Content library -----
  app.get('/api/packs', readers, (_req, res) =>
    res.json(svc.registry.list().map(({ clauses, controls, evalCases, ...p }) => ({ ...p, clauseCount: clauses.length, controlCount: controls.length, evalCaseCount: evalCases.length }))),
  );
  app.get('/api/packs/:id', readers, wrap((req, res) => {
    const pack = svc.registry.packs.get(param(req, 'id'));
    if (!pack) throw new AppError(404, 'Pack not found');
    res.json(pack);
  }));
  app.get('/api/search', readers, (req, res) => {
    const q = String(req.query.q ?? '');
    const packIds = req.query.packs ? String(req.query.packs).split(',') : svc.registry.list().map((p) => p.id);
    const allowed = new Set(svc.registry.clausesFor(packIds).map((c) => c.id));
    const hits = svc.grounding.clauses.search(q, 10, (id) => allowed.has(id));
    res.json(hits.map((h) => ({ ...h, clause: svc.registry.clauses.get(h.clauseId) })));
  });

  // ----- Engagements -----
  app.get('/api/engagements', readers, wrap(async (_req, res) => res.json(await svc.listEngagements())));
  app.post('/api/engagements', readers, wrap(async (req, res) => {
    const body = NewEngagementSchema.parse(req.body);
    res.status(201).json(await svc.createEngagement(body, actorOf(req)));
  }));
  app.get('/api/engagements/:id', readers, wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    res.set('ETag', `"${e.version}"`).json(e);
  }));

  app.post('/api/engagements/:id/modules/:moduleId/run', readers, wrap(async (req, res) => {
    const { bundle, engagement } = await svc.runModule(param(req, 'id'), param(req, 'moduleId'), actorOf(req), req.body ?? {}, mutation(req));
    res.json({ bundle, engagement });
  }));

  app.put('/api/engagements/:id/scope', readers, wrap(async (req, res) => {
    const items = z.array(z.object({ controlId: z.string(), included: z.boolean() })).parse(req.body.items);
    res.json(await svc.setScope(param(req, 'id'), items, actorOf(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/tests/:rowId', readers, wrap(async (req, res) => {
    res.json(await svc.recordTest(param(req, 'id'), param(req, 'rowId'), TestInputSchema.parse(req.body), actorOf(req), mutation(req)));
  }));

  app.put('/api/engagements/:id/findings/:fid', readers, wrap(async (req, res) => {
    res.json(await svc.editFinding(param(req, 'id'), param(req, 'fid'), FindingPatchSchema.parse(req.body), actorOf(req), mutation(req)));
  }));

  app.post('/api/engagements/:id/findings/:fid/signoff', readers, wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['review', 'approve', 'reject']), comment: z.string().default('') }).parse(req.body);
    res.json(await svc.signOff(param(req, 'id'), param(req, 'fid'), body.action, body.comment, actorOf(req), mutation(req)));
  }));

  app.get('/api/engagements/:id/report.md', readers, wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    if (!e.report) throw new AppError(404, 'No report generated yet');
    res.type('text/markdown').attachment(`${e.id}-report.md`).send(e.report.markdown);
  }));

  app.get('/api/engagements/:id/findings.csv', readers, wrap(async (req, res) => {
    res.type('text/csv').attachment(`${param(req, 'id')}-findings.csv`).send(await svc.findingsCsv(param(req, 'id')));
  }));

  // ----- Evidence & validation -----
  app.get('/api/engagements/:id/trail', readers, wrap(async (req, res) => res.json(await svc.trailFor(param(req, 'id')))));
  app.get('/api/trail/verify', readers, wrap(async (_req, res) => res.json(await svc.verifyTrail())));

  app.post('/api/eval/run', evaluators, wrap(async (_req, res) => {
    const report = await runEval(svc.registry, svc.llm);
    await svc.saveEvalRun(report);
    res.json(report);
  }));
  app.get('/api/eval/runs', readers, wrap(async (_req, res) => res.json(await svc.listEvalRuns())));
  app.get('/api/eval/runs/:id', readers, wrap(async (req, res) => {
    const r = await svc.getEvalRun(param(req, 'id'));
    if (!r) throw new AppError(404, 'Eval run not found');
    res.json({ ...r, markdown: evalMarkdown(r) });
  }));
  app.get('/api/validation/traceability', readers, wrap(async (_req, res) => res.json(buildTraceability(await svc.latestEvalRun()))));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', issues: err.issues });
    console.error(err);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  });

  return app;
}
