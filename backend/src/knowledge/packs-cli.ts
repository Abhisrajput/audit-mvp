import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PACKS_DIR } from './okf/bundle';
import { loadLegacyPack, packToFiles } from './okf/migrate-json';

// Content-pack commands. In the container: node dist/knowledge/packs-cli.js <command>
//   migrate [--from <dir>] [--to <dir>]   convert <from>/<pack>/pack.json into OKF bundles under <to>/<pack>/ (once)

const USAGE = 'Usage: packs-cli migrate [--from <dir>] [--to <dir>]';

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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'migrate') migrateCommand(args);
  else throw new Error(USAGE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
