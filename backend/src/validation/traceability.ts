import fs from 'node:fs';
import path from 'node:path';
import type { EvalReport } from '../eval/harness';

// Requirements traceability for the validation package: each user requirement
// is linked to the automated tests (tagged [REQ-xx] in their titles) and the
// evaluation-harness evidence that verify it.

export interface Requirement {
  id: string;
  text: string;
  risk: 'High' | 'Medium' | 'Low';
  evalKinds?: string[];
}

const ROOT = path.resolve(__dirname, '../..');

export function loadRequirements(file = process.env.TRACEABILITY_REQUIREMENTS ?? path.join(ROOT, 'validation/requirements.json')): Requirement[] {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function testsByRequirement(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = path.join(ROOT, 'tests');
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\bit\(\s*['"`]([^'"`]*\[(REQ-\d+(?:,\s*REQ-\d+)*)\][^'"`]*)['"`]/g)) {
      for (const id of m[2].split(/,\s*/)) out.set(id, [...(out.get(id) ?? []), `${file}: ${m[1]}`]);
    }
  }
  return out;
}

export function buildTraceability(latestEval: EvalReport | null) {
  const tests = testsByRequirement();
  const rows = loadRequirements().map((r) => {
    const evals = (r.evalKinds ?? []).map((k) => {
      const s = latestEval?.byKind[k];
      return s ? `${k} eval ${s.passed}/${s.total} (${latestEval!.id})` : `${k} eval (not run)`;
    });
    const verifiedBy = [...(tests.get(r.id) ?? []), ...evals];
    const evalCovered = (r.evalKinds ?? []).some((k) => latestEval?.byKind[k]?.total);
    return { ...r, verifiedBy, covered: (tests.get(r.id)?.length ?? 0) > 0 || !!evalCovered };
  });
  const markdown = [
    '# Requirements traceability matrix',
    '',
    `Generated ${new Date().toISOString()}. ${rows.filter((r) => r.covered).length}/${rows.length} requirements have automated test or evaluation coverage.`,
    '',
    '| Req | Risk | Requirement | Verified by |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.risk} | ${r.text} | ${r.verifiedBy.length ? r.verifiedBy.join('<br>') : '**NOT COVERED**'} |`),
  ].join('\n');
  return { rows, markdown };
}
