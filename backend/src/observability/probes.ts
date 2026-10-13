import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import type { Db } from '../db';
import { AppError } from '../errors';
import { refreshRunGauge } from '../agents/metrics';
import { wrap } from '../http-util';
import type { BlobStore } from '../storage/blob-store';
import { logger } from './log';
import { registry } from './metrics';

// Mounted at the root, outside sessions. nginx proxies only /api/ and /auth/, so these stay on the internal network.

export interface ProbeDeps {
  db: Db;
  blobs: BlobStore | null;
  metricsToken: string | null;
  timeoutMs?: number;
  /** Report agent runs by status at each scrape. The API does; the worker leaves it to the API so it is never reported twice. */
  agentRuns?: boolean;
}

/** A key no upload can have: head() answers null when the store is reachable and throws when it is not. */
const PROBE_KEY = '0'.repeat(64);

async function check(name: string, fn: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'timeout' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
  try {
    const result = await Promise.race([fn().then(() => 'ok' as const), timeout]);
    if (result === 'timeout') logger.warn({ check: name, timeoutMs }, 'readiness check timed out');
    return result;
  } catch (err) {
    logger.warn({ check: name, err }, 'readiness check failed');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

function sameToken(sent: string, expected: string) {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function probeRoutes(deps: ProbeDeps): Router {
  const r = Router();
  const timeoutMs = deps.timeoutMs ?? 2000;

  r.get('/healthz', (_req, res) => res.json({ ok: true }));

  r.get('/readyz', wrap(async (_req, res) => {
    const checks: Record<string, string> = {
      database: await check('database', () => sql`select 1`.execute(deps.db.kysely), timeoutMs),
      storage: deps.blobs ? await check('storage', () => deps.blobs!.head(PROBE_KEY), timeoutMs) : 'not configured',
    };
    const ok = Object.values(checks).every((v) => v === 'ok' || v === 'not configured');
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ ok, checks });
  }));

  r.get('/metrics', wrap(async (req, res) => {
    if (deps.metricsToken && !sameToken(req.header('authorization') ?? '', `Bearer ${deps.metricsToken}`)) {
      throw new AppError(401, 'Metrics need the bearer token', 'UNAUTHENTICATED');
    }
    if (deps.agentRuns) {
      // A failed count leaves the last values in place rather than failing the whole scrape.
      await refreshRunGauge(deps.db.kysely).catch((err) => logger.warn({ err }, 'could not count agent runs for /metrics'));
    }
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  }));

  return r;
}
