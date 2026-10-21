import cookieParser from 'cookie-parser';
import express, { type Request } from 'express';
import { z } from 'zod';
import { adminRoutes } from './auth/admin-routes';
import { defaultAgentConfig, type AgentConfig } from './agents/config';
import { agentRoutes } from './agents/routes';
import { actorOf, requireRole, requireUser, sessionMiddleware } from './auth/http';
import { PREPARER_ROLES, READ_ROLES } from './auth/roles';
import { authRoutes, type AuthDeps } from './auth/routes';
import { errorHandler } from './http/errors';
import { DEFAULT_RATE_LIMITS, rateLimiters, securityHeaders, type RateLimits } from './http/security';
import { visibleTrail } from './knowledge/trail-visibility';
import { documentRoutes, UPLOAD_PATH, type StorageDeps } from './knowledge/routes';
import { requestContext } from './observability/context';
import { accessLog } from './observability/log';
import { httpMetrics } from './observability/metrics';
import { probeRoutes } from './observability/probes';
import { signingRoutes } from './signing/routes';
import { evalMarkdown, runEval } from './eval/harness';
import { ifMatch, wrap } from './http-util';
import type { Impact, Likelihood } from './engine/types';
import { EngagementContextInputSchema } from './judgment/context';
import { IMPACTS, LIKELIHOODS } from './judgment/finding';
import { TOLERANCE_MAX } from './judgment/sampling';
import { METHODOLOGY_PACK_ID } from './judgment/standards';
import { AppError, AuditService } from './service';
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
  context: EngagementContextInputSchema.optional(),
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
    likelihood: z.enum([...LIKELIHOODS] as [Likelihood, ...Likelihood[]]),
    impact: z.enum([...IMPACTS] as [Impact, ...Impact[]]),
    condition: z.string().min(1),
    criteria: z.string().min(1),
    cause: z.string().min(1),
    effect: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  })
  .partial()
  .strict();

/** Routes that parse their own bodies (see documentRoutes). */
const OWN_BODY_PARSER = new Set([UPLOAD_PATH, '/api/documents']);

/** Operational settings. */
export interface OpsOptions {
  /** Proxy hops to trust (TRUST_PROXY); above 0, a forwarded X-Request-Id is reused. */
  trustProxy?: number;
  /** Per-client request limits; tests lower them. */
  rateLimits?: RateLimits;
  /** Bearer token for /metrics; null leaves it open (local development). */
  metricsToken?: string | null;
  /** Per-check readiness timeout in ms (default 2000); tests lower it. */
  probeTimeoutMs?: number;
  /** Agent orchestration settings (AGENT_*); defaults when absent. */
  agents?: AgentConfig;
}

export function createApp(
  svc: AuditService,
  auth: AuthDeps,
  storage: StorageDeps = { blobs: null, maxUploadBytes: 25 * 1024 * 1024, presignDownloads: false },
  ops: OpsOptions = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ops.trustProxy ?? 0);
  app.use(requestContext({ trustProxy: ops.trustProxy ?? 0 }));
  app.use(accessLog());
  app.use(httpMetrics());
  app.use(securityHeaders());
  app.use(probeRoutes({ db: svc.db, blobs: storage.blobs, metricsToken: ops.metricsToken ?? null, timeoutMs: ops.probeTimeoutMs, agentRuns: true }));
  const limits = rateLimiters(ops.rateLimits ?? DEFAULT_RATE_LIMITS);
  app.use('/auth', limits.auth);
  app.use('/auth/sign', limits.signing);
  app.post('/api/engagements/:id/findings/:fid/sign-intents', limits.signing);
  app.post('/api/gates/:gateId/sign-intents', limits.signing);
  // Same-origin only: the UI is served behind the same host (nginx or the Vite proxy), so no CORS.
  app.use(cookieParser());
  // The upload route reads the raw body (any file, JSON included) and registration has its own, larger JSON limit,
  // so the global parser skips both: a body parsed here would never reach their own parsers.
  const json = express.json({ limit: '1mb' });
  app.use((req, res, next) => (OWN_BODY_PARSER.has(req.path.toLowerCase().replace(/\/+$/, '')) ? next() : json(req, res, next)));
  app.use(sessionMiddleware(svc.db.kysely, auth.config));

  const param = (req: Request, name: string) => String(req.params[name]);

  // ----- Public -----
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: svc.providerInfo }));
  const signing = signingRoutes(svc, auth);
  app.use(authRoutes(svc.db, auth, { idpCallback: signing.handleIdpCallback }));

  // ----- Everything below needs a signed-in user with a role (and CSRF on changes) -----
  app.use('/api', requireUser());
  const readers = requireRole(READ_ROLES);
  const evaluators = requireRole([...PREPARER_ROLES, 'cae']);
  app.use(adminRoutes(svc.db, auth.config));
  app.use(signing.router);
  app.use(documentRoutes(svc, storage));
  app.use(agentRoutes(svc, ops.agents ?? defaultAgentConfig()));

  app.get('/api/modules', readers, (_req, res) => res.json(svc.modules()));

  // ----- Content library -----
  app.get('/api/packs', readers, (_req, res) =>
    res.json(svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID).map(({ clauses, controls, evalCases, ...p }) => ({ ...p, clauseCount: clauses.length, controlCount: controls.length, evalCaseCount: evalCases.length }))),
  );
  app.get('/api/packs/:id', readers, wrap((req, res) => {
    const pack = svc.registry.packs.get(param(req, 'id'));
    if (!pack) throw new AppError(404, 'Pack not found');
    res.json(pack);
  }));
  app.get('/api/search', readers, (req, res) => {
    const q = String(req.query.q ?? '');
    const packIds = req.query.packs ? String(req.query.packs).split(',') : svc.registry.list().filter((p) => p.id !== METHODOLOGY_PACK_ID).map((p) => p.id);
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
    const e = await svc.engagementWithSignatureStatus(param(req, 'id'));
    res.set('ETag', `"${e.version}"`).json(e);
  }));

  app.post('/api/engagements/:id/modules/:moduleId/run', readers, wrap(async (req, res) => {
    const { bundle, engagement } = await svc.runModule(param(req, 'id'), param(req, 'moduleId'), actorOf(req), req.body ?? {}, ifMatch(req));
    res.json({ bundle, engagement });
  }));

  app.put('/api/engagements/:id/scope', readers, wrap(async (req, res) => {
    const items = z.array(z.object({ controlId: z.string(), included: z.boolean() })).parse(req.body.items);
    res.json(await svc.setScope(param(req, 'id'), items, actorOf(req), ifMatch(req)));
  }));

  app.put('/api/engagements/:id/context', readers, wrap(async (req, res) => {
    res.json(await svc.setEngagementContext(param(req, 'id'), EngagementContextInputSchema.parse(req.body), actorOf(req), ifMatch(req)));
  }));

  app.put('/api/engagements/:id/tests/:rowId', readers, wrap(async (req, res) => {
    res.json(await svc.recordTest(param(req, 'id'), param(req, 'rowId'), TestInputSchema.parse(req.body), actorOf(req), ifMatch(req)));
  }));

  app.put('/api/engagements/:id/tolerances/:controlId', readers, wrap(async (req, res) => {
    const { rate } = z.object({ rate: z.number().min(0).max(TOLERANCE_MAX) }).strict().parse(req.body);
    res.json(await svc.setTolerance(param(req, 'id'), param(req, 'controlId'), rate, actorOf(req), ifMatch(req)));
  }));

  app.put('/api/engagements/:id/findings/:fid', readers, wrap(async (req, res) => {
    res.json(await svc.editFinding(param(req, 'id'), param(req, 'fid'), FindingPatchSchema.parse(req.body), actorOf(req), ifMatch(req)));
  }));

  app.post('/api/engagements/:id/findings/:fid/signoff', readers, () => {
    throw new AppError(428, 'Signing needs re-authentication: start a signing request (POST …/sign-intents) instead', 'REAUTH_REQUIRED');
  });

  app.get('/api/engagements/:id/report.md', readers, wrap(async (req, res) => {
    const e = await svc.engagement(param(req, 'id'));
    if (!e.report) throw new AppError(404, 'No report generated yet');
    res.type('text/markdown').attachment(`${e.id}-report.md`).send(e.report.markdown);
  }));

  app.get('/api/engagements/:id/findings.csv', readers, wrap(async (req, res) => {
    res.type('text/csv').attachment(`${param(req, 'id')}-findings.csv`).send(await svc.findingsCsv(param(req, 'id')));
  }));

  // ----- Evidence & validation -----
  app.get('/api/engagements/:id/trail', readers, wrap(async (req, res) => res.json(visibleTrail(await svc.trailFor(param(req, 'id')), actorOf(req).role))));
  app.get('/api/trail/verify', readers, wrap(async (_req, res) => res.json(await svc.verifyTrail())));

  app.post('/api/eval/run', evaluators, wrap(async (_req, res) => {
    const report = await runEval(svc.registry, svc.llm, undefined, svc.citationPolicy);
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

  app.use(errorHandler());

  return app;
}
