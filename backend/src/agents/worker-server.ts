import express from 'express';
import type { Server } from 'node:http';
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

/**
 * Starts the probe server, or fails with the reason (the port already taken, most often). Without it a failed listen is
 * an uncaught error after the worker has started taking runs, or a worker with no probes at all.
 */
export function listenProbes(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    const failed = (err: Error) => reject(new Error(`Cannot serve probes and metrics on port ${port}: ${err.message}`));
    server.once('error', failed);
    server.once('listening', () => {
      server.off('error', failed);
      resolve(server);
    });
  });
}
