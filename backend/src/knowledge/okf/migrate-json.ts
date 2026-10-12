import fs from 'node:fs';
import { z } from 'zod';
import type { ContentPack } from '../../engine/types';
import { renderControlBody } from './control-body';
import { renderMarkdown } from './frontmatter';
import { slugOf } from './schema';

// One-time conversion of the MVP's pack.json files into OKF bundles (spec §6.3, `npm run packs:migrate`).
// Honest by construction: nothing is marked verified, and everything is due for re-review in 12 months.

// The pre-OKF pack.json contract, kept so packs:migrate works after the pack.json files are gone.

const ClauseSchema = z.object({
  id: z.string().min(1),
  regulation: z.string().min(1),
  ref: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()),
  reviewStatus: z.enum(['draft', 'expert-reviewed']),
  sourceUrl: z.string().optional(),
});

const ControlSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  processArea: z.string().min(1),
  objective: z.string().min(1),
  risk: z.string().min(1),
  riskRating: z.enum(['High', 'Medium', 'Low']),
  type: z.enum(['Preventive', 'Detective']),
  nature: z.enum(['Manual', 'Automated', 'IT-dependent manual']),
  frequency: z.enum(['Annual', 'Quarterly', 'Monthly', 'Weekly', 'Daily', 'Per event', 'Per batch']),
  clauseRefs: z.array(z.string()).min(1),
  testOfDesign: z.array(z.string()).min(1),
  testOfEffectiveness: z.array(z.string()).min(1),
  evidenceExpected: z.array(z.string()).min(1),
  checklist: z.array(z.string()),
  recommendation: z.string().min(1),
  keywords: z.array(z.string()),
});

const EvalCaseSchema = z.object({
  id: z.string(),
  kind: z.enum(['retrieval', 'testing', 'gaps']),
  description: z.string(),
  input: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
});

export const LegacyPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  vertical: z.string().min(1),
  description: z.string(),
  disclaimer: z.string(),
  sources: z.record(z.string(), z.string()).default({}),
  clauses: z.array(ClauseSchema),
  controls: z.array(ControlSchema),
  evalCases: z.array(EvalCaseSchema).default([]),
});

export interface MigrationStamp {
  version: string;
  generatedBy: string;
  generatedAt: string;
  staleAfter: string;
}

export const MVP_MIGRATION: MigrationStamp = { version: '0.2.0', generatedBy: 'mvp-pack-migration', generatedAt: '2026-10-11', staleAfter: '2027-10-11' };

export function loadLegacyPack(file: string): ContentPack {
  const parsed = LegacyPackSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid content pack ${file}: ${parsed.error.message}`);
  return parsed.data as ContentPack;
}

function singleLine(value: string, what: string) {
  if (/[\r\n]/.test(value)) throw new Error(`${what} spans several lines; a control body section holds one line per item`);
  return value;
}

/** The bundle's files, keyed by path relative to the pack folder. */
export function packToFiles(pack: ContentPack, stamp: MigrationStamp = MVP_MIGRATION): Map<string, string> {
  const files = new Map<string, string>();
  const put = (rel: string, text: string) => {
    if (files.has(rel)) throw new Error(`${pack.id}/${rel}: two concepts share this file name`);
    files.set(rel, text);
  };
  const okf = { generated: { by: stamp.generatedBy, at: stamp.generatedAt }, verified: null, status: 'active', stale_after: stamp.staleAfter };

  put('pack.md', renderMarkdown({
    type: 'pack', title: pack.name, description: pack.description, tags: [pack.vertical], ...okf,
    x_audit: { id: pack.id, version: stamp.version, vertical: pack.vertical, classification: 'internal', citation_prefixes: pack.sources },
  }, pack.disclaimer));

  for (const c of pack.clauses) {
    put(`clauses/${slugOf(c.id)}.md`, renderMarkdown({
      type: 'clause', title: c.title, description: c.summary, tags: c.tags,
      ...(c.sourceUrl ? { sources: [{ ref: c.sourceUrl }] } : {}), ...okf,
      x_audit: { id: c.id, regulation: c.regulation, ref: c.ref },
    }, ''));
  }

  for (const c of pack.controls) {
    const where = `${pack.id} control ${c.id}`;
    put(`controls/${slugOf(c.id)}.md`, renderMarkdown({
      type: 'control', title: c.title, tags: c.keywords, sources: c.clauseRefs.map((r) => ({ ref: `/clauses/${slugOf(r)}.md` })), ...okf,
      x_audit: {
        id: c.id, process_area: c.processArea, risk: c.risk, risk_rating: c.riskRating, type: c.type, nature: c.nature,
        frequency: c.frequency, clause_refs: c.clauseRefs, evidence_expected: c.evidenceExpected,
      },
    }, renderControlBody({
      objective: singleLine(c.objective, `${where} objective`),
      testOfDesign: c.testOfDesign.map((x) => singleLine(x, `${where} test of design`)),
      testOfEffectiveness: c.testOfEffectiveness.map((x) => singleLine(x, `${where} test of effectiveness`)),
      checklist: c.checklist.map((x) => singleLine(x, `${where} checklist`)),
      recommendation: singleLine(c.recommendation, `${where} recommendation`),
    })));
  }

  for (const e of pack.evalCases) {
    put(`eval/${slugOf(e.id)}.md`, renderMarkdown({
      type: 'eval_case', title: e.id, description: e.description, ...okf,
      x_audit: { id: e.id, kind: e.kind, input: e.input, expected: e.expected },
    }, ''));
  }
  return files;
}
