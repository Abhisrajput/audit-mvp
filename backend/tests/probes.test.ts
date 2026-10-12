import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { LlmProvider } from '../src/engine/llm/provider';
import { instrumentProvider } from '../src/observability/llm';
import { registry } from '../src/observability/metrics';
import type { BlobStore } from '../src/storage/blob-store';
import { appWithDevUsers, devAuthConfig, devSign, draftFinding, signIn } from './http';

const TOKEN = 't'.repeat(32);

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)!.get();
  const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

const storeWith = (head: BlobStore['head']): BlobStore => ({
  driver: 's3', head, put: async () => ({ sha256: '', size: 0 }), get: async () => { throw new Error('unused'); }, presignedGet: async () => null,
});

describe('probes and metrics', () => {
  it('answers liveness without touching dependencies, and readiness from the database and file storage', async () => {
    const { svc, app } = await appWithDevUsers();
    expect((await request(app).get('/healthz').expect(200)).body).toEqual({ ok: true });
    expect((await request(app).get('/readyz').expect(200)).body).toEqual({ ok: true, checks: { database: 'ok', storage: 'not configured' } });

    const reachable = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(async () => null), maxUploadBytes: 1024, presignDownloads: false });
    expect((await request(reachable).get('/readyz').expect(200)).body.checks.storage).toBe('ok');

    const down = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(async () => { throw new Error('AccessDenied for key …'); }), maxUploadBytes: 1024, presignDownloads: false });
    expect((await request(down).get('/readyz').expect(503)).body).toEqual({ ok: false, checks: { database: 'ok', storage: 'error' } });

    const hanging = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs: storeWith(() => new Promise(() => undefined)), maxUploadBytes: 1024, presignDownloads: false }, { probeTimeoutMs: 50 });
    expect((await request(hanging).get('/readyz').expect(503)).body.checks.storage).toBe('timeout');
  });

  it('serves metrics only with the bearer token, labelled by route pattern rather than raw URL', async () => {
    const { svc } = await appWithDevUsers();
    const app = createApp(svc, { config: devAuthConfig(), oidc: null }, undefined, { metricsToken: TOKEN });
    const user = await signIn(app, 'auditor');
    await user.get('/api/engagements/ENG-NOPE123').expect(404);
    await request(app).get('/metrics').expect(401);
    await request(app).get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/audit_http_request_duration_seconds_count\{method="GET",route="\/api\/engagements\/:id",status="404"\} [1-9]/);
    expect(res.text).toMatch(/audit_http_errors_total\{code="NOT_FOUND"\} [1-9]/);
    expect(res.text).toContain('audit_trail_append_seconds_count');
    expect(res.text).toContain('audit_process_cpu_seconds_total');
    expect(res.text).not.toContain('ENG-NOPE123');
  });

  it('counts model calls, fallbacks and tokens', async () => {
    const ok: LlmProvider = { id: 'probe', model: 'm1', generate: async () => ({ output: {} as never, servedModel: 'm1', usage: { inputTokens: 120, outputTokens: 30 } }) };
    const switched: LlmProvider = { id: 'probe', model: 'm1', generate: async () => ({ output: {} as never, servedModel: 'm1-fallback' }) };
    const failing: LlmProvider = { id: 'probe', model: 'm1', generate: async () => { throw new Error('overloaded'); } };
    const before = {
      ok: await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'ok' }),
      error: await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'error' }),
      input: await metricValue('audit_llm_tokens_total', { provider: 'probe', kind: 'input' }),
      model: await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'model' }),
      deterministic: await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'deterministic' }),
    };
    const req = { system: 's', user: 'u', schema: {} as never };
    await instrumentProvider(ok)!.generate(req);
    await instrumentProvider(switched)!.generate(req);
    await expect(instrumentProvider(failing)!.generate(req)).rejects.toThrow('overloaded');
    expect(instrumentProvider(null)).toBeNull();
    expect(await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'ok' })).toBe(before.ok + 2);
    expect(await metricValue('audit_llm_calls_total', { provider: 'probe', outcome: 'error' })).toBe(before.error + 1);
    expect(await metricValue('audit_llm_tokens_total', { provider: 'probe', kind: 'input' })).toBe(before.input + 120);
    expect(await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'model' })).toBe(before.model + 1);
    expect(await metricValue('audit_llm_fallbacks_total', { provider: 'probe', kind: 'deterministic' })).toBe(before.deterministic + 1);
  });

  it('counts failed signatures by reason', async () => {
    const { app } = await appWithDevUsers();
    const { id, fid } = await draftFinding(app);
    const reviewer = await signIn(app, 'reviewer');
    const before = await metricValue('audit_signature_failures_total', { code: 'REAUTH_USER_MISMATCH' });
    const r = await devSign(reviewer, 'reviewer', id, fid, 'review', 'someone-else');
    expect(r.status!.status).toBe('failed');
    expect(await metricValue('audit_signature_failures_total', { code: 'REAUTH_USER_MISMATCH' })).toBe(before + 1);
  });
});
