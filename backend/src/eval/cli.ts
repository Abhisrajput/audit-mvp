import fs from 'node:fs';
import path from 'node:path';
import { createProvider } from '../engine/llm/router';
import { registryFromBundles } from '../knowledge/packs';
import { evalMarkdown, runEval } from './harness';

// Usage: npm run eval [-- --provider anthropic] [--packs food,pharma]
async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const registry = registryFromBundles();
  const report = await runEval(registry, createProvider(arg('provider') ?? 'offline'), arg('packs')?.split(','));
  const outDir = path.resolve(__dirname, '../../validation-output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'eval-latest.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'eval-latest.md'), evalMarkdown(report));
  console.log(evalMarkdown(report));
  process.exitCode = report.passed === report.total ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
