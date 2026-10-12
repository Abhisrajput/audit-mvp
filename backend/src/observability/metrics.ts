import type { RequestHandler } from 'express';
import client from 'prom-client';

// Prometheus metrics (spec §7.5). One registry for the process; label values are bounded (route patterns,
// error codes, provider ids), never raw URLs or user input.

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'audit_' });

const registers = [registry];

export const httpDuration = new client.Histogram({
  name: 'audit_http_request_duration_seconds', help: 'HTTP request duration by matched route',
  labelNames: ['method', 'route', 'status'] as const, buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers,
});
export const httpErrors = new client.Counter({ name: 'audit_http_errors_total', help: 'Error responses by error code', labelNames: ['code'] as const, registers });
export const llmCalls = new client.Counter({ name: 'audit_llm_calls_total', help: 'Model calls by outcome', labelNames: ['provider', 'outcome'] as const, registers });
export const llmFallbacks = new client.Counter({
  name: 'audit_llm_fallbacks_total', help: 'Model fallbacks: kind=model (served by another model) or deterministic (offline rules used)',
  labelNames: ['provider', 'kind'] as const, registers,
});
export const llmTokens = new client.Counter({ name: 'audit_llm_tokens_total', help: 'Model tokens by kind', labelNames: ['provider', 'kind'] as const, registers });
export const trailAppendSeconds = new client.Histogram({
  name: 'audit_trail_append_seconds', help: 'Time to seal and append one trail bundle, including the chain lock wait',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], registers,
});
export const signatureFailures = new client.Counter({ name: 'audit_signature_failures_total', help: 'Failed signing attempts by reason', labelNames: ['code'] as const, registers });

/** Observes every request's duration under its matched route pattern ("unmatched" when no route handled it). */
export function httpMetrics(): RequestHandler {
  return (req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}
