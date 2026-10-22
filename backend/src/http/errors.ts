import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AppError, type ErrorCode } from '../errors';
import { UPLOAD_PATH } from '../knowledge/routes';
import { logger } from '../observability/log';
import { httpErrors } from '../observability/metrics';

type PgResponse = { status: number; code: ErrorCode; message: string };

/** Postgres errors a request can legitimately cause, answered without echoing Postgres's own text (it can hold key values). */
const PG_ERRORS: Record<string, PgResponse> = {
  '23505': { status: 409, code: 'CONFLICT', message: 'This record already exists' },
  '23503': { status: 400, code: 'VALIDATION', message: 'This refers to a record that does not exist' },
  '23514': { status: 400, code: 'VALIDATION', message: 'This value is not allowed' },
  '22P05': { status: 400, code: 'VALIDATION', message: 'This text contains characters that cannot be stored' },
};

const IMMUTABLE: PgResponse = { status: 403, code: 'RECORD_IMMUTABLE', message: 'This record cannot be changed' };

/**
 * The append-only triggers (reject_change and its kin: "<table> is append-only: …") and the approved-finding lock
 * ("Approved finding … is locked: …") raise insufficient_privilege. So does a privilege the API role lacks
 * ("permission denied for …"), but that is a server fault, not something the request did: it stays unexpected.
 */
const TRIGGER_REFUSAL = /\bis append-only: |\bis locked: /;

export function pgErrorResponse(err: unknown): PgResponse | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !(err instanceof Error)) return null;
  if (code === '42501') return TRIGGER_REFUSAL.test(err.message) ? IMMUTABLE : null;
  return PG_ERRORS[code] ?? null;
}

/** Every error body is { error, code, requestId }; an unexpected error reveals nothing but its code and request id. */
export function errorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.requestId;
    if (err instanceof AppError) {
      httpErrors.inc({ code: err.code });
      return res.status(err.status).json({ ...err.extra, error: err.message, code: err.code, requestId });
    }
    if (err instanceof z.ZodError) {
      httpErrors.inc({ code: 'VALIDATION' });
      return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', requestId, issues: err.issues });
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      httpErrors.inc({ code: 'VALIDATION' });
      const upload = req.path.toLowerCase().startsWith(UPLOAD_PATH);
      return res.status(413).json({ error: upload ? 'The file is larger than the upload limit' : 'The request body is larger than the limit', code: 'VALIDATION', requestId });
    }
    if (type === 'entity.parse.failed') {
      httpErrors.inc({ code: 'VALIDATION' });
      return res.status(400).json({ error: 'The request body is not valid JSON', code: 'VALIDATION', requestId });
    }
    // Any other body-parser refusal (encoding.unsupported, charset.unsupported, request.aborted, ...) is the client's doing:
    // answered with its 4xx status, so anonymous clients cannot raise INTERNAL alerts.
    const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
    if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
      httpErrors.inc({ code: 'VALIDATION' });
      logger.warn({ requestId, type, status }, 'request body rejected');
      return res.status(status).json({ error: 'The request body could not be read', code: 'VALIDATION', requestId });
    }
    const pg = pgErrorResponse(err);
    if (pg) {
      httpErrors.inc({ code: pg.code });
      const e = err as { code: string; detail?: string; constraint?: string; table?: string; message: string };
      logger.warn({ requestId, pg: { code: e.code, message: e.message, detail: e.detail, constraint: e.constraint, table: e.table } }, 'database refused the request');
      return res.status(pg.status).json({ error: pg.message, code: pg.code, requestId });
    }
    httpErrors.inc({ code: 'INTERNAL' });
    logger.error({ requestId, err }, 'unexpected error');
    res.status(500).json({ code: 'INTERNAL', requestId });
  };
}
