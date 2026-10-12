import type { NextFunction, Request, Response } from 'express';

/** Forwards errors from async route handlers to the Express error middleware. */
export const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);
