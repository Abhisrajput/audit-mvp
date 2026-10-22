import { loadAgentConfig } from './agents/config';
import { loadAssistantConfig } from './assistant/config';
import { createApp } from './app';
import { createBlobStore } from './storage/config';
import { createOidcClient } from './auth/oidc';
import { ensureDevUsers } from './auth/dev-users';
import { loadServerConfig, prepareEnv } from './config';
import { connectPg } from './db';
import { pendingMigrations } from './db/migrate';
import { createProvider } from './engine/llm/router';
import { instrumentProvider } from './observability/llm';
import { loadBundles } from './knowledge/okf/bundle';
import { prepareRegistry } from './knowledge/packs';
import { logger, setLogLevel } from './observability/log';
import { AuditService } from './service';

async function main() {
  prepareEnv();
  const { core: config, auth, storage, citationPolicy } = loadServerConfig();
  const agents = loadAgentConfig();
  const assistant = loadAssistantConfig();
  setLogLevel(config.logLevel);
  const blobs = createBlobStore(storage);
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl });
  const pending = await pendingMigrations(db);
  if (pending.length) {
    await db.close();
    throw new Error(
      `Database has unapplied migrations (${pending.join(', ')}). Run "npm run migrate" ` +
        '(in the container: node dist/db/cli.js migrate) first; the API never migrates on start-up.',
    );
  }
  if (auth.devAuth) {
    await ensureDevUsers(db.kysely);
    logger.warn('DEV_AUTH is on: demo sign-in is enabled. Never use this in production.');
    if (auth.oidc) {
      logger.warn(
        '!!! WARNING: DEV_AUTH=true AND OIDC is configured. Anyone who can reach this server can sign in as a demo ' +
          'user (including the admin) without a password, alongside real identity-provider users. Use this only for ' +
          'local testing on a machine nobody else can reach; set DEV_AUTH=false anywhere else.',
      );
    }
  }
  let registry;
  try {
    registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production', log: (line) => logger.info(line) });
  } catch (err) {
    await db.close();
    throw err;
  }
  const oidc = auth.oidc ? await createOidcClient(auth.oidc) : null;
  if (oidc) logger.info(`Sign-in via ${auth.oidc!.issuer}`);
  if (citationPolicy.allowUnverified) {
    logger.warn('ALLOW_UNVERIFIED_CITATIONS is on: findings may cite knowledge no reviewer has verified (flagged, not blocked). Never use this in production.');
  }
  if (!config.metricsToken) logger.warn('METRICS_TOKEN is not set: /metrics is open. Set it outside local development.');
  if (!agents.enabled) logger.warn('AGENT_ENABLED=false: agent runs cannot be started');
  if (!assistant.enabled) logger.warn('ASSISTANT_ENABLED=false: the chat assistant is switched off');
  const svc = new AuditService(db, registry, instrumentProvider(createProvider()), { citationPolicy });
  createApp(svc, { config: auth, oidc }, { blobs, maxUploadBytes: storage.maxBytes, presignDownloads: storage.presignDownloads }, { trustProxy: config.trustProxy, metricsToken: config.metricsToken, agents, assistant }).listen(config.port, () => {
    logger.info(`Audit platform API on :${config.port} — packs: ${registry.list().map((p) => `${p.id}@${p.version}`).join(', ')} — provider: ${svc.providerInfo.id}/${svc.providerInfo.model} — files: ${blobs.driver}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
