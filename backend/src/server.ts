import { createApp } from './app';
import { loadAuthConfig } from './auth/config';
import { ensureDevUsers } from './auth/dev-users';
import { loadConfig, loadDotEnv } from './config';
import { connectPg } from './db';
import { pendingMigrations } from './db/migrate';
import { createProvider } from './engine/llm/router';
import { PackRegistry } from './engine/packs';
import { AuditService } from './service';

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const auth = loadAuthConfig();
  const db = connectPg(config.databaseUrl);
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
    console.warn('DEV_AUTH is on: demo sign-in is enabled. Never use this in production.');
  }
  const registry = PackRegistry.loadFromDir(config.packsDir);
  const svc = new AuditService(db, registry, createProvider());
  createApp(svc, { config: auth }).listen(config.port, () => {
    console.log(`Audit platform API on :${config.port} — packs: ${registry.list().map((p) => `${p.id}@${p.version}`).join(', ')} — provider: ${svc.providerInfo.id}/${svc.providerInfo.model}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
