import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { httpErrors } from '../observability/metrics';

// Spec §7.6. The API answers JSON and a few tiny HTML pages (sign-in and signing pop-ups), so its policy
// allows nothing by default; those pages replace it with a per-response script nonce (auth/page.ts).
// The browser app itself is served by nginx, which sends the SPA's own policy (frontend/nginx/default.conf.template).

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"] },
    },
    // same-origin is safe: the app never reads the signing window through window.opener; it polls the request status.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export interface RateLimits {
  authPerMinute: number;
  signingPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { authPerMinute: 60, signingPerMinute: 20 };

/**
 * Per-client limits, keyed by the client address Express derives under `trust proxy` (TRUST_PROXY).
 * In memory: the pilot runs one API replica; more replicas need a shared store.
 */
export function rateLimiters(limits: RateLimits) {
  const make = (limit: number): RequestHandler =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // A forwarded header without a trusted proxy is ignored on purpose (the socket address is used); don't warn about it.
      validate: { xForwardedForHeader: false },
      handler: (req, res) => {
        httpErrors.inc({ code: 'RATE_LIMITED' });
        res.status(429).json({ error: 'Too many requests; wait a minute and try again', code: 'RATE_LIMITED', requestId: req.requestId });
      },
    });
  return { auth: make(limits.authPerMinute), signing: make(limits.signingPerMinute) };
}
