import { createApp } from './app';
import { loadAuthConfig } from './auth/config';
import { createBlobStore, loadStorageConfig } from './storage/config';
import { createOidcClient } from './auth/oidc';
import { ensureDevUsers } from './auth/dev-users';
import { loadCitationPolicy, loadConfig, loadDotEnv } from './config';
import { connectPg } from './db';
import { pendingMigrations } from './db/migrate';
import { createProvider } from './engine/llm/router';
import { loadBundles } from './knowledge/okf/bundle';
import { prepareRegistry } from './knowledge/packs';
import { AuditService } from './service';

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const citationPolicy = loadCitationPolicy();
  const auth = loadAuthConfig();
  const storage = loadStorageConfig();
  const blobs = createBlobStore(storage);
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
    if (auth.oidc) {
      console.warn(
        '!!! WARNING: DEV_AUTH=true AND OIDC is configured. Anyone who can reach this server can sign in as a demo ' +
          'user (including the admin) without a password, alongside real identity-provider users. Use this only for ' +
          'local testing on a machine nobody else can reach; set DEV_AUTH=false anywhere else.',
      );
    }
  }
  let registry;
  try {
    registry = await prepareRegistry(db, loadBundles(config.packsDir), { production: process.env.NODE_ENV === 'production' });
  } catch (err) {
    await db.close();
    throw err;
  }
  const oidc = auth.oidc ? await createOidcClient(auth.oidc) : null;
  if (oidc) console.log(`Sign-in via ${auth.oidc!.issuer}`);
  if (citationPolicy.allowUnverified) {
    console.warn('ALLOW_UNVERIFIED_CITATIONS is on: findings may cite knowledge no reviewer has verified (flagged, not blocked). Never use this in production.');
  }
  const svc = new AuditService(db, registry, createProvider(), { citationPolicy });
  createApp(svc, { config: auth, oidc }, { blobs, maxUploadBytes: storage.maxBytes, presignDownloads: storage.presignDownloads }).listen(config.port, () => {
    console.log(`Audit platform API on :${config.port} — packs: ${registry.list().map((p) => `${p.id}@${p.version}`).join(', ')} — provider: ${svc.providerInfo.id}/${svc.providerInfo.model} — files: ${blobs.driver}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
