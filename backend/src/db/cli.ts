import { loadConfig, prepareEnv } from '../config';
import { verifyIntegrity } from '../ops/verify';
import type { BlobStore } from '../storage/blob-store';
import { createBlobStore, loadStorageConfig } from '../storage/config';
import { importJson } from './import-json';
import { connectPg } from './index';
import { migrate } from './migrate';

// Operator commands. In the container: node dist/db/cli.js <command>
//   migrate              apply pending SQL migrations
//   import-json <file>   import an MVP data/db.json into an empty database
//   verify               check the trail chain, signatures and stored documents (exit 1 on any problem)

const USAGE = 'Usage: cli <migrate | import-json <file> | verify>';

async function main() {
  prepareEnv();
  const [command, arg] = process.argv.slice(2);
  if (!['migrate', 'import-json', 'verify'].includes(command)) throw new Error(USAGE);
  const config = loadConfig();
  const db = connectPg(config.databaseUrl, { max: 2, ssl: config.databaseSsl });
  try {
    if (command === 'migrate') {
      const applied = await migrate(db);
      console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
    } else if (command === 'import-json') {
      if (!arg) throw new Error(USAGE);
      const counts = await importJson(db, arg);
      console.log(`Imported ${counts.engagements} engagement(s), ${counts.trail} trail bundle(s), ${counts.evalRuns} eval run(s); chain verified`);
    } else {
      // verify: trail chain, signatures and stored documents (exit 1 on any problem)
      let blobs: BlobStore | null = null;
      let skipped: string | null = null;
      try {
        blobs = createBlobStore(loadStorageConfig());
      } catch (err) {
        skipped = `file storage is not configured: ${(err instanceof Error ? err.message : String(err)).replace(/^Invalid configuration:\n\s*-\s*/, '').split('\n')[0]}`;
      }
      const report = await verifyIntegrity(db.kysely, blobs, skipped);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
