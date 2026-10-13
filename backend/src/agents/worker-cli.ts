import { loadWorkerConfig, prepareEnv } from '../config';
import { connectPg } from '../db';
import { pendingMigrations } from '../db/migrate';
import { createProvider } from '../engine/llm/router';
import { loadBundles } from '../knowledge/okf/bundle';
import { prepareRegistry } from '../knowledge/packs';
import { instrumentProvider } from '../observability/llm';
import { logger, setLogLevel, setLogService } from '../observability/log';
import { AuditService } from '../service';
import { AgentWorker } from './worker';
import { workerProbeApp } from './worker-server';

// The agent worker process: same image as the API, started with `node dist/agents/worker-cli.js` (npm run worker).
// It connects as the API's database role and never migrates. Its probes and metrics are on WORKER_PORT (default 3003).

async function main() {
  prepareEnv();
  setLogService('audit-worker');
  const { core: config, citationPolicy, agents, port } = loadWorkerConfig();
  setLogLevel(config.logLevel);
  if (!config.metricsToken) logger.warn("METRICS_TOKEN is not set: the worker's /metrics is open. Set it outside local development.");
  // One connection more than the loops need, for readiness checks while every loop is busy.
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl, max: agents.concurrency * 2 + 2 });
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(`Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" first; the worker never migrates.`);
  }
  const registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production', log: (line) => logger.info(line) });
  const svc = new AuditService(db, registry, instrumentProvider(createProvider()), { citationPolicy });
  const worker = new AgentWorker(svc, agents);
  let stopping = false;
  const server = workerProbeApp({ db, metricsToken: config.metricsToken, stopping: () => stopping }).listen(port);
  if (!agents.enabled) logger.warn('AGENT_ENABLED=false: this worker takes no agent runs');
  worker.start();
  logger.info(`Agent worker ${worker.id}: ${agents.concurrency} loop(s), polling every ${agents.pollMs} ms, provider ${svc.providerInfo.id}/${svc.providerInfo.model}, probes and metrics on :${port}`);
  const shutdown = async () => {
    if (stopping) return;
    // Readiness fails from here on, so no orchestrator waits on this worker.
    stopping = true;
    logger.info('Agent worker stopping');
    // Give an iteration in flight one lease to finish; after that its lease expires and another worker takes the run.
    const bound = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), agents.leaseMs).unref());
    const result = await Promise.race([worker.stop().then(() => 'stopped' as const), bound]);
    if (result === 'timeout') {
      logger.error('Agent worker did not stop within its lease; exiting');
      process.exit(1);
    }
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
