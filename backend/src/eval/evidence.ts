import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentConfig } from '../agents/config';
import { ModelMeter } from '../agents/budget';
import { AgentModels } from '../agents/llm/models';
import { checkQuotes, draftEvidenceWithModel, type EvidenceDraftResult, type PageTexts } from '../agents/specialists/evidence';
import { NO_SPEND } from '../agents/types';
import { DEV_USERS, ensureDevUsers } from '../auth/dev-users';
import type { LlmProvider } from '../engine/llm/provider';
import type { RcmRow, TestPlan } from '../engine/types';
import { documentPageText } from '../evidence/text';
import { insertExtraction } from '../evidence/extraction-repo';
import { insertDocument, setDocumentText } from '../knowledge/document-repo';
import type { AuditService } from '../service';
import type { EvalCaseResult } from './harness';

// Evidence-drafting eval cases (REQ-41): fixture documents are registered as client text on a scratch engagement, the
// evidence specialist drafts one row from them, and the draft is held to what the documents say. The offline cases run
// the rules drafter and cost nothing; the `needsModel` cases run only with a model, as information.

export interface EvidenceCase {
  id: string;
  description: string;
  /** File names under eval/evidence/. */
  documents: string[];
  rowId: string;
  plan: TestPlan;
  row: RcmRow;
  expect: { foundDocuments: string[] } & ({ needsModel?: false } | { needsModel: true; exceptionsMax: number; sampleMin: number });
}

export const EVIDENCE_DIR = path.resolve(__dirname, '../../eval/evidence');
export const EVIDENCE_CASES_FILE = path.join(EVIDENCE_DIR, 'cases.json');

export function loadEvidenceCases(file: string = EVIDENCE_CASES_FILE): EvidenceCase[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvidenceCase[];
}

const PACK_ID = 'pharma';
const RUN_ID = 'EVAL-EVIDENCE';

/** The drafter's result for one case, with the file name of each registered document and the text the quotes are held to. */
export interface CaseDrafts extends EvidenceDraftResult {
  names: Map<string, string>;
  texts: Map<string, PageTexts>;
}

/** Registers the case's documents on a scratch engagement and drafts its row: with `models` the model drafter, otherwise the rules. */
export async function draftEvidenceForCase(c: EvidenceCase, svc: AuditService, models?: AgentModels, dir: string = EVIDENCE_DIR): Promise<CaseDrafts> {
  const db = svc.db.kysely;
  await ensureDevUsers(db);
  const user = DEV_USERS[0];
  const scratch = await svc.createEngagement(
    { name: `Evidence eval: ${c.id}`, entity: 'Demo Pharma', site: 'OSD plant', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'GMP self-inspection', scopeStatement: c.row.control, packIds: [PACK_ID] },
    user,
  );
  const names = new Map<string, string>();
  const texts = new Map<string, PageTexts>();
  for (const file of c.documents) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const doc = await insertDocument(db, {
      sha256: crypto.createHash('sha256').update(`${scratch.id}:${file}:${text}`).digest('hex'), filename: file, mime: 'text/plain', size: Buffer.byteLength(text),
      kind: 'evidence', classification: 'internal', engagementId: scratch.id, uploadedBy: user.id,
    });
    await setDocumentText(db, doc, { extractor: 'client', extractorVersion: '1', text, pageStarts: [] });
    await insertExtraction(db, { documentId: doc.id, extractor: 'client', extractorVersion: '1', status: 'client', chars: text.length, pages: null, error: null, by: user.id });
    names.set(doc.id, file);
    const read = await documentPageText(db, doc.id);
    if (read) texts.set(doc.id, { pages: read.pages, byPage: new Map([[null, read.text]]) });
  }
  const e = { ...(await svc.engagement(scratch.id)), rcm: [c.row], testPlans: { [c.row.id]: c.plan }, testInputs: {}, testDrafts: {} };
  const out = await draftEvidenceWithModel(e, { models, db, user, runId: RUN_ID });
  return { ...out, names, texts };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export async function runEvidenceCase(c: EvidenceCase, svc: AuditService, llm: LlmProvider | null, models?: AgentModels): Promise<EvalCaseResult> {
  const needsModel = c.expect.needsModel === true;
  const base = { id: `evidence:${c.id}`, packId: PACK_ID, kind: 'evidence' as const, description: c.description, ...(needsModel ? { informational: true } : {}) };
  try {
    let usable = models;
    if (needsModel && !usable && llm) {
      const cfg = defaultAgentConfig();
      usable = new AgentModels(llm, cfg.llm, new ModelMeter(cfg.budget, NO_SPEND, async () => {}));
    }
    if (needsModel && !usable) return { ...base, passed: false, detail: 'the model did not answer (no model is configured)' };
    const out = await draftEvidenceForCase(c, svc, needsModel ? usable : undefined);
    const draft = out.drafts[c.row.id];
    if (!draft) return { ...base, passed: false, detail: `no draft: ${out.noDraft.map((n) => n.reason).join('; ') || 'none saved'}` };
    if (needsModel && (out.withoutModel || draft.draftedBy.model === 'rules')) return { ...base, passed: false, detail: 'the model did not answer (the draft fell back to the rules)' };

    const problems: string[] = [];
    const found = [...new Set(draft.evidence.map((x) => out.names.get(x.documentId) ?? x.documentId))];
    if (!sameSet(found, c.expect.foundDocuments)) problems.push(`expected documents ${c.expect.foundDocuments.join(', ') || 'none'}, found ${found.join(', ') || 'none'}`);
    const missing = checkQuotes(draft, out.texts);
    if (missing.length) problems.push(`${missing.length} quote(s) not verbatim in the cited document`);
    if (draft.qa.blocking.length) problems.push(`blocked: ${draft.qa.blocking.join(', ')}`);
    if (needsModel && c.expect.needsModel) {
      const p = draft.proposal;
      if (!p) problems.push('no proposal');
      else {
        if (p.exceptions > c.expect.exceptionsMax) problems.push(`${p.exceptions} exceptions, above ${c.expect.exceptionsMax}`);
        if (p.sampleTested < c.expect.sampleMin) problems.push(`${p.sampleTested} items tested, below ${c.expect.sampleMin}`);
      }
    } else if (draft.proposal) {
      problems.push('the rules draft carries a proposal');
    }
    return { ...base, passed: problems.length === 0, detail: problems.join('; ') || `found ${found.join(', ') || 'no documents'}; ${draft.evidence.length} quote(s) verbatim${draft.proposal ? `; proposal ${draft.proposal.exceptions}/${draft.proposal.sampleTested}` : '; no proposal'}` };
  } catch (err) {
    return { ...base, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A missing or malformed cases file (the container image may not carry eval/) is one failed row, so the eval request still answers. */
export async function runEvidenceCases(llm: LlmProvider | null, svc: AuditService, opts: { file?: string; models?: AgentModels } = {}): Promise<EvalCaseResult[]> {
  const file = opts.file ?? EVIDENCE_CASES_FILE;
  let cases: EvidenceCase[];
  try {
    cases = loadEvidenceCases(file);
    if (!Array.isArray(cases)) throw new Error('the cases file is not a list');
  } catch (err) {
    return [{ id: 'evidence:cases-missing', packId: PACK_ID, kind: 'evidence', description: 'The evidence cases file could not be read', passed: false, detail: `${file}: ${err instanceof Error ? err.message : String(err)}` }];
  }
  const rows: EvalCaseResult[] = [];
  for (const c of cases) rows.push(await runEvidenceCase(c, svc, llm, opts.models));
  return rows;
}
