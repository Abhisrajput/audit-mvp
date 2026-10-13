import type { RequestHandler } from 'express';
import pino from 'pino';
import type { LogLevel } from '../config';
import { currentContext } from './context';

// JSON logs on stdout. Secrets are redacted wherever they appear in a logged object (spec §7.6).
// Tests run silent unless they capture logs (captureLogs), so test output stays clean.

export const REDACTED_PATHS = [
  'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
  'headers.cookie', 'headers.authorization', 'headers["x-csrf-token"]',
  '*.password', '*.clientSecret', '*.token', '*.secret', '*.csrfToken', '*.secretAccessKey', '*.connectionString',
];

let sink: (line: string) => void = (line) => process.stdout.write(line);

const LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** LOG_LEVEL at import; an invalid value falls back here and loadServerConfig reports it at start-up. */
const defaultLevel = (): LogLevel => {
  const env = process.env.LOG_LEVEL;
  if (env && LEVELS.includes(env)) return env as LogLevel;
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
};

let service = 'audit-api';

/** Names the process on every log line: 'audit-api' (the default) or 'audit-worker'. */
export function setLogService(name: string) {
  service = name;
}

export const logger = pino(
  {
    level: defaultLevel(),
    base: null,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Every line names its process. Lines logged while a request is served carry its id; lines logged while the worker
    // runs a step carry the run's id too. A line that names its own requestId or runId (the access log, written after
    // the request's async context has ended) keeps it.
    mixin: (obj) => {
      const ctx = currentContext();
      return {
        service,
        ...(ctx && !('requestId' in obj) ? { requestId: ctx.requestId } : {}),
        ...(ctx?.runId && !('runId' in obj) ? { runId: ctx.runId } : {}),
      };
    },
  },
  { write: (line: string) => sink(line) },
);

export function setLogLevel(level: LogLevel) {
  logger.level = level;
}

/** Test helper: collects log lines at `level` until restore(). */
export function captureLogs(level: LogLevel = 'trace') {
  const lines: string[] = [];
  const previous = { sink, level: logger.level };
  sink = (line) => lines.push(line);
  logger.level = level;
  return {
    text: () => lines.join(''),
    restore() {
      sink = previous.sink;
      logger.level = previous.level;
    },
  };
}

// Read without relying on auth/http's Request augmentation: the frontend type-checks this file (via the
// engine and eval types it imports) without the auth module in its program.
const userOf = (req: unknown): string | null => (req as { auth?: { user: { id: string } } }).auth?.user.id ?? null;

const QUIET = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * One line per request: method, matched route (never the raw URL), status, duration, user, and the client address
 * as derived under TRUST_PROXY (what the rate limits count), so an operator can check the hop count on a real request.
 */
export function accessLog(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      // finish may fire outside the request's async context, so the id is passed explicitly.
      const entry = { requestId: req.requestId, method: req.method, route, status: res.statusCode, ms: Math.round(ms * 10) / 10, user: userOf(req), ip: req.ip };
      if (QUIET.has(req.path)) logger.debug(entry, 'request');
      else logger.info(entry, 'request');
    });
    next();
  };
}
