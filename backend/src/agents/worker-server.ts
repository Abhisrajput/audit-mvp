import express from 'express';
import type { Db } from '../db';
import { errorHandler } from '../http/errors';
import { probeRoutes } from '../observability/probes';

// The worker's own small HTTP server (spec §6.4): liveness and readiness for its container, and the metrics the worker
// counts. It serves nothing else, has no sessions, and is never exposed outside the deployment's network.

export interface WorkerProbeDeps {
  db: Db;
  metricsToken: string | null;
  /** True once the worker is shutting down: readiness then fails, so nothing waits on it. */
  stopping: () => boolean;
  timeoutMs?: number;
}

export function workerProbeApp(deps: WorkerProbeDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(probeRoutes({
    db: deps.db, blobs: null, metricsToken: deps.metricsToken, timeoutMs: deps.timeoutMs,
    extraChecks: () => ({ worker: deps.stopping() ? 'stopping' : 'ok' }),
  }));
  app.use(errorHandler());
  return app;
}
