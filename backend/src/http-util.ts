import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import type { MutationOptions } from './service';

/** Forwards errors from async route handlers to the Express error middleware. */
export const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

/** `If-Match: "<version>"` opts a change into the optimistic-concurrency check. */
export function ifMatch(req: Request): MutationOptions {
  const header = req.header('if-match');
  if (header === undefined) return {};
  const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'If-Match must be the engagement version number');
  return { expectedVersion: version };
}
