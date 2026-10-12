import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContentPack } from '../src/engine/types';
import { MVP_MIGRATION, packToFiles } from '../src/knowledge/okf/migrate-json';

// Shared OKF test fixtures: a tiny pack, and helpers that write it to a temporary packs directory.

export const FIXTURE: ContentPack = {
  id: 'demo', name: 'Demo Pack', version: '0.1.0', vertical: 'common', description: 'Demo content.',
  disclaimer: 'Draft content; not reviewed by a domain expert.', sources: { 'Demo Standard 2020': 'DS' },
  clauses: [
    { id: 'DS-2', regulation: 'Demo Standard 2020', ref: 'Clause 2', title: 'Records', summary: 'Records are kept and reviewed.', tags: ['records'], reviewStatus: 'draft', sourceUrl: 'https://example.org/ds#2' },
    { id: 'DS-1', regulation: 'Demo Standard 2020', ref: 'Clause 1', title: 'Policy', summary: 'A records policy exists.', tags: ['policy'], reviewStatus: 'draft' },
  ],
  controls: [{
    id: 'DM-01', title: 'Records are reviewed', processArea: 'Records', objective: 'Ensure records are complete.', risk: 'Incomplete records.',
    riskRating: 'High', type: 'Detective', nature: 'Manual', frequency: 'Monthly', clauseRefs: ['DS-2', 'DS-1'],
    testOfDesign: ['Inspect the procedure.'], testOfEffectiveness: ['Sample 10 records.', 'Check sign-off.'], evidenceExpected: ['Review log'],
    checklist: [], recommendation: 'Review records monthly.', keywords: ['review', 'records'],
  }],
  evalCases: [{ id: 'DM-R1', kind: 'retrieval', description: 'Finds the records clause', input: { query: 'records kept' }, expected: { clauseIds: ['DS-2'], k: 3 } }],
};

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** What a migrated pack must equal: the original at the new version, concepts ordered by id, trust left aside. */
export function expectedAfterMigration(p: ContentPack): ContentPack {
  return { ...p, version: MVP_MIGRATION.version, clauses: byId(p.clauses), controls: byId(p.controls), evalCases: byId(p.evalCases) };
}
export function withoutTrust(p: ContentPack): ContentPack {
  return {
    ...p,
    clauses: p.clauses.map(({ trust: _t, ...c }) => c),
    controls: p.controls.map(({ trust: _t, ...c }) => c),
  };
}

export function writeBundle(root: string, packId: string, files: Map<string, string>) {
  for (const [rel, text] of files) {
    const file = path.join(root, packId, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'okf-'));

export function demoRoot(edit?: (files: Map<string, string>) => void) {
  const root = tmpRoot();
  const files = packToFiles(FIXTURE);
  edit?.(files);
  writeBundle(root, 'demo', files);
  return root;
}
