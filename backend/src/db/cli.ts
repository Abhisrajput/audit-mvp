import { loadConfig, loadDotEnv } from '../config';
import { verifyChain } from '../engine/trail';
import { importJson } from './import-json';
import { connectPg } from './index';
import { migrate } from './migrate';
import { readTrail } from './trail-repo';

// Operator commands. In the container: node dist/db/cli.js <command>
//   migrate              apply pending SQL migrations
//   import-json <file>   import an MVP data/db.json into an empty database
//   verify               recompute the audit-trail hash chain (exit 1 if broken)

const USAGE = 'Usage: cli <migrate | import-json <file> | verify>';

async function main() {
  loadDotEnv();
  const [command, arg] = process.argv.slice(2);
  if (!['migrate', 'import-json', 'verify'].includes(command)) throw new Error(USAGE);
  const db = connectPg(loadConfig().databaseUrl, { max: 2 });
  try {
    if (command === 'migrate') {
      const applied = await migrate(db);
      console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
    } else if (command === 'import-json') {
      if (!arg) throw new Error(USAGE);
      const counts = await importJson(db, arg);
      console.log(`Imported ${counts.engagements} engagement(s), ${counts.trail} trail bundle(s), ${counts.evalRuns} eval run(s); chain verified`);
    } else {
      const result = verifyChain(await readTrail(db.kysely));
      console.log(JSON.stringify(result));
      if (!result.valid) process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
