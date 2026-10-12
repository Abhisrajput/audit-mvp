import fs from 'node:fs';
import path from 'node:path';
import type { EvalReport } from '../eval/harness';
import { buildTraceability } from './traceability';

const outDir = path.resolve(__dirname, '../../validation-output');
const evalFile = path.join(outDir, 'eval-latest.json');
const latest: EvalReport | null = fs.existsSync(evalFile) ? JSON.parse(fs.readFileSync(evalFile, 'utf8')) : null;
const { markdown, rows } = buildTraceability(latest);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'traceability.md'), markdown);
console.log(markdown);
const uncovered = rows.filter((r) => !r.covered).map((r) => r.id);
if (uncovered.length) {
  console.error(`Requirements without automated evidence: ${uncovered.join(', ')}`);
  process.exitCode = 1;
}
