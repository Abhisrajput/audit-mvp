import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { startRun } from '../src/agents/runs';
import { AgentWorker } from '../src/agents/worker';
import { listenProbes, workerProbeApp } from '../src/agents/worker-server';
import { ensureDevUsers } from '../src/auth/dev-users';
import { captureLogs, logger, setLogService } from '../src/observability/log';
import { auditor, NEW_ENGAGEMENT, newService } from './helpers';

const TOKEN = 'w'.repeat(32);

describe('the worker process', () => {
  it('logs every line of a run step with its runId, as the worker service', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
    const { run } = await startRun(svc, defaultAgentConfig(), e.id, auditor);
    vi.spyOn(svc, 'runModuleAsAgent').mockImplementation(async () => {
      // A line from deep inside the step, which knows nothing about the run.
      logger.info('deep inside the step');
      throw new Error('specialist failed');
    });
    setLogService('audit-worker');
    const logs = captureLogs('info');
    try {
      await new AgentWorker(svc, defaultAgentConfig(), { id: 'w-logs' }).tick();
    } finally {
      logs.restore();
      setLogService('audit-api');
    }
    const lines = logs.text().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.msg === 'deep inside the step')).toMatchObject({ runId: run.id, requestId: run.id, service: 'audit-worker' });
    expect(lines.find((l) => l.msg === 'agent run step failed')).toMatchObject({ runId: run.id, service: 'audit-worker' });
  });

  it('serves liveness, readiness from the database and the worker loop, and metrics behind the token', async () => {
    const svc = await newService();
    let stopping = false;
    const app = workerProbeApp({ db: svc.db, metricsToken: TOKEN, stopping: () => stopping });
    expect((await request(app).get('/healthz').expect(200)).body).toEqual({ ok: true });
    expect((await request(app).get('/readyz').expect(200)).body).toEqual({ ok: true, checks: { database: 'ok', storage: 'not configured', worker: 'ok' } });
    await request(app).get('/metrics').expect(401);
    const metrics = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(metrics.text).toContain('audit_agent_step_duration_seconds');
    // Runs by status are the API's to report.
    expect(metrics.text).not.toMatch(/audit_agent_runs\{/);
    stopping = true;
    expect((await request(app).get('/readyz').expect(503)).body).toMatchObject({ ok: false, checks: { worker: 'stopping' } });
  });

  it('fails to start, rather than run with no probes, when its port is already taken', async () => {
    const svc = await newService();
    const taken = net.createServer().listen(0);
    await once(taken, 'listening');
    const port = (taken.address() as AddressInfo).port;
    const app = workerProbeApp({ db: svc.db, metricsToken: TOKEN, stopping: () => false });
    try {
      await expect(listenProbes(app, port)).rejects.toThrow(new RegExp(`port ${port}.*EADDRINUSE`));
      taken.close();
      await once(taken, 'close');
      const server = await listenProbes(app, port);
      expect((await request(`http://127.0.0.1:${port}`).get('/healthz').expect(200)).body).toEqual({ ok: true });
      server.close();
      await once(server, 'close');
    } finally {
      if (taken.listening) taken.close();
    }
  });
});
