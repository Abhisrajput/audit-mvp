import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from '../config';
import { connectPg } from '../db';
import { pendingMigrations } from '../db/migrate';
import { compileDir } from './graph/compile';
import { DEFAULT_PACKS_DIR } from './okf/bundle';
import { loadLegacyPack, packToFiles } from './okf/migrate-json';

// Content-pack commands. In the container: node dist/knowledge/packs-cli.js <command>
//   compile [--dir <packs dir>]           compile the bundles into the knowledge graph (a release step, like migrate)
//   migrate [--from <dir>] [--to <dir>]   convert <from>/<pack>/pack.json into OKF bundles under <to>/<pack>/ (once)

const USAGE = 'Usage: packs-cli <compile [--dir <dir>] | migrate [--from <dir>] [--to <dir>]>';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function migrateCommand(args: string[]) {
  const from = path.resolve(arg(args, 'from') ?? DEFAULT_PACKS_DIR);
  const to = path.resolve(arg(args, 'to') ?? DEFAULT_PACKS_DIR);
  let converted = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const json = path.join(from, entry.name, 'pack.json');
    if (!entry.isDirectory() || !fs.existsSync(json)) continue;
    const pack = loadLegacyPack(json);
    const files = packToFiles(pack);
    for (const rel of files.keys()) {
      const target = path.join(to, pack.id, rel);
      if (fs.existsSync(target)) throw new Error(`${target} already exists; packs:migrate never overwrites a bundle`);
    }
    for (const [rel, text] of files) {
      const target = path.join(to, pack.id, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    console.log(`${pack.id}: ${files.size} files written to ${path.join(to, pack.id)}`);
    converted++;
  }
  if (!converted) throw new Error(`No pack.json found under ${from}`);
}

async function compileCommand(args: string[]) {
  loadDotEnv();
  const config = loadConfig();
  const dir = path.resolve(arg(args, 'dir') ?? config.packsDir ?? DEFAULT_PACKS_DIR);
  const db = connectPg(config.databaseUrl, { max: 2 });
  try {
    const pending = await pendingMigrations(db);
    if (pending.length) throw new Error(`Database has unapplied migrations (${pending.join(', ')}); run migrate first`);
    const r = await compileDir(db, dir);
    for (const p of r.packs) console.log(`${p.packId}@${p.version}: ${p.outcome}`);
    if (r.trailBundleId) console.log(`${r.nodes} nodes, ${r.edges} edges, ${r.chunks} chunks, ${r.deprecated} deprecated; trail ${r.trailBundleId}`);
  } finally {
    await db.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'compile') await compileCommand(args);
  else if (command === 'migrate') migrateCommand(args);
  else throw new Error(USAGE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
