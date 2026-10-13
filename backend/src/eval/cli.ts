import fs from 'node:fs';
import path from 'node:path';
import { loadCitationPolicy, prepareEnv } from '../config';
import { createProvider } from '../engine/llm/router';
import { createMemoryDb } from '../db/pglite';
import { compilePacks } from '../knowledge/graph/compile';
import { loadBundles } from '../knowledge/okf/bundle';
import { registryFromGraph } from '../knowledge/packs';
import { evalArgs, evalMarkdown, runEval } from './harness';

// Usage: npm run eval [-- --provider anthropic] [--packs food,pharma] [--update-traces] [--agent-llm]
// --agent-llm also runs each agent scenario with the provider's model (informational and paid, on a $2 budget per scenario).
async function main() {
  prepareEnv();
  const policy = loadCitationPolicy();
  const args = evalArgs(process.argv.slice(2));
  if (args.agentLlm && args.provider === 'offline') throw new Error('--agent-llm needs a model provider (--provider anthropic)');
  // Eval qualifies the registry the API serves: compiled into a graph (a throwaway in-process database) and read back.
  const bundles = loadBundles();
  const graph = await createMemoryDb();
  let registry;
  try {
    await compilePacks(graph, bundles);
    registry = await registryFromGraph(graph.kysely, bundles.map((b) => b.packId));
  } finally {
    await graph.close();
  }
  const report = await runEval(registry, createProvider(args.provider), args.packs, policy, { agentTraces: true, updateTraces: args.updateTraces, agentLlm: args.agentLlm });
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
