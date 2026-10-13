import { loadCitationPolicy, loadConfig, prepareEnv } from '../config';
import { connectPg } from '../db';
import { pendingMigrations } from '../db/migrate';
import { createProvider } from '../engine/llm/router';
import { loadBundles } from '../knowledge/okf/bundle';
import { prepareRegistry } from '../knowledge/packs';
import { instrumentProvider } from '../observability/llm';
import { logger, setLogLevel } from '../observability/log';
import { AuditService } from '../service';
import { loadAgentConfig } from './config';
import { AgentWorker } from './worker';

// The agent worker process: same image as the API, started with `node dist/agents/worker-cli.js` (npm run worker).
// It connects as the API's database role and never migrates.

async function main() {
  prepareEnv();
  const config = loadConfig();
  const citationPolicy = loadCitationPolicy();
  const agents = loadAgentConfig();
  setLogLevel(config.logLevel);
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl, max: agents.concurrency + 2 });
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(`Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" first; the worker never migrates.`);
  }
  const registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production', log: (line) => logger.info(line) });
  const svc = new AuditService(db, registry, instrumentProvider(createProvider()), { citationPolicy });
  const worker = new AgentWorker(svc, agents);
  if (!agents.enabled) logger.warn('AGENT_ENABLED=false: this worker takes no agent runs');
  worker.start();
  logger.info(`Agent worker ${worker.id}: ${agents.concurrency} loop(s), polling every ${agents.pollMs} ms, provider ${svc.providerInfo.id}/${svc.providerInfo.model}`);
  const shutdown = async () => {
    logger.info('Agent worker stopping');
    await worker.stop();
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
