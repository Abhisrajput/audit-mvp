import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

// Per-request context that follows async work, so logs and trail bundles written while serving a request
// carry its id without threading it through every call.

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

interface RequestContext {
  requestId: string;
  /** Set while the agent worker runs one step of a run: its log lines carry it as runId. */
  runId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** What an incoming X-Request-Id must look like to be reused (nginx's $request_id is 32 hex characters). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

export const currentContext = (): RequestContext | undefined => storage.getStore();

/**
 * Gives each request an id: a trusted proxy's X-Request-Id when there is one (TRUST_PROXY > 0), otherwise a new UUID.
 * A client talking to the API directly can't choose the id that is written into the audit trail.
 */
export function requestContext(opts: { trustProxy: number }): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = opts.trustProxy > 0 && incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    storage.run({ requestId }, () => next());
  };
}

/** Runs work outside an HTTP request (the agent worker) under a request id, so its logs and trail bundles carry it. */
export function runWithRequestId<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ requestId }, fn);
}

/**
 * Runs one step of an agent run (spec §6.4): its log lines carry runId, and trail bundles it writes carry the run id
 * as their request id, as they always have.
 */
export function runForAgentRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ requestId: runId, runId }, fn);
}
