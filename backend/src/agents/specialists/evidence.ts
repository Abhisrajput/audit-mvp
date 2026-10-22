import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../../db/schema';
import type { Executor } from '../../db/trail-repo';
import { asData, DATA_RULES } from '../../engine/llm/prompt';
import { MalformedOutputError } from '../../engine/llm/provider';
import type { DraftEvidence, Engagement, RcmRow, TestDraft, TestPlan, User } from '../../engine/types';
import { AppError } from '../../errors';
import { documentPageText } from '../../evidence/text';
import { CLASSIFICATIONS_BY_ROLE } from '../../knowledge/access';
import { listDocuments } from '../../knowledge/document-repo';
import { ModelUnavailableError, type AgentModels } from '../llm/models';
import { draftIssues } from '../qa/drafts';
import { searchKnowledge, type KnowledgeHit } from '../tools/knowledge';
import type { Toolbox } from '../tools/toolbox';

// The evidence specialist (spec §9.1). It reads the evidence already on the engagement and proposes a result for rows
// that have a test plan and no recorded test. It never writes a test input: a proposal lives in a draft until a person
// accepts it. Every quote in a draft is checked, in code, against the cited page; a draft whose quote is not there is
// kept for the person to see, blocked and without its proposal.

export const MAX_QUOTE = 300;
const HITS_PER_ROW = 8;
const MAX_READ_PAGES = 6;
const MAX_SHOWN_CHARS = 12_000;
const MAX_QUERY = 200;

export const EVIDENCE_SYSTEM = `You propose the result of one control test for internal-audit field work, using only the evidence documents given. You propose; a person decides. Be sceptical: a document that merely describes a control is not proof it operated. Record sampleTested and exceptions only as far as the documents show them. If the documents do not settle something, say so in couldNotVerify and leave the proposal out. Quote only text that appears verbatim in the cited document, and cite its page. Never invent a quote, a document or a count.
${DATA_RULES}`;

export const ModelDraftSchema = z.object({
  proposal: z.object({
    designAdequate: z.boolean().nullable(),
    sampleTested: z.number().int().min(0),
    exceptions: z.number().int().min(0),
    observation: z.string().max(2000),
  }).optional(),
  evidence: z.array(z.object({ documentId: z.string(), page: z.number().int().min(1).optional(), quote: z.string().max(MAX_QUOTE) })).max(20),
  couldNotVerify: z.array(z.string()).max(10),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type ModelDraft = z.infer<typeof ModelDraftSchema>;

/** One document's text as read: the page count (null without page breaks) and the text by page (null key: the whole text). */
export interface PageTexts { pages: number | null; byPage: Map<number | null, string> }

/** A passage the search found: the text of one chunk, not its snippet. */
export interface FoundPassage { documentId: string; page: number | null; text: string }

export interface DraftOptions {
  models?: AgentModels;
  toolbox?: Toolbox;
  db: Kysely<DB>;
  user: User;
  runId: string;
  now?: () => string;
}

export interface EvidenceDraftResult {
  drafts: Record<string, TestDraft>;
  noDraft: { rowId: string; reason: string }[];
  withoutModel: boolean;
}

/** Rows with a test plan and no recorded test, that a person has not already taken over. */
export const rowsToDraft = (e: Engagement): RcmRow[] =>
  e.rcm.filter((r) => e.testPlans[r.id] && !e.testInputs[r.id] && !e.testDrafts[r.id]?.personEdited);

/** Whitespace runs become one space and the ends are trimmed; nothing else is normalised. */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The structural checks that make a draft unusable: a document that is not evidence on this engagement, more exceptions
 * than items tested, a page missing or out of range, or a quote over the length cap. Whether a quote is in the text is
 * checkQuotes' question: that draft is kept, blocked.
 */
export function verifyDraft(draft: ModelDraft, texts: Map<string, PageTexts>, engagementDocIds: Set<string>): { ok: true; draft: ModelDraft } | { ok: false; reason: string } {
  const p = draft.proposal;
  if (p && p.exceptions > p.sampleTested) return { ok: false, reason: `the draft records ${p.exceptions} exceptions in ${p.sampleTested} items tested` };
  for (const ev of draft.evidence) {
    if (!engagementDocIds.has(ev.documentId)) return { ok: false, reason: `the draft cites ${ev.documentId}, which is not evidence on this engagement` };
    if (ev.quote.length > MAX_QUOTE) return { ok: false, reason: `a quote from ${ev.documentId} is over ${MAX_QUOTE} characters` };
    const t = texts.get(ev.documentId);
    if (t?.pages != null) {
      if (ev.page === undefined) return { ok: false, reason: `the draft cites ${ev.documentId} without a page` };
      if (ev.page > t.pages) return { ok: false, reason: `the draft cites page ${ev.page} of ${ev.documentId}, which has ${t.pages}` };
    }
  }
  return { ok: true, draft };
}

/** The quotes that are not in the cited page (the whole text when the document has no pages), after collapsing whitespace. */
export function checkQuotes(draft: { evidence: { documentId: string; page?: number; quote: string }[] }, texts: Map<string, PageTexts>): string[] {
  const missing: string[] = [];
  for (const ev of draft.evidence) {
    const t = texts.get(ev.documentId);
    const text = t?.byPage.get(t.pages === null ? null : ev.page ?? null);
    const quote = collapse(ev.quote);
    if (text === undefined || !quote || !collapse(text).includes(quote)) missing.push(ev.quote);
  }
  return missing;
}

/** First sentence of a passage: up to the first ". " or line break, at most MAX_QUOTE characters. */
function firstSentence(text: string): string {
  const t = text.trim();
  const stops = [t.indexOf('. '), t.indexOf('\n')].filter((i) => i >= 0);
  const end = stops.length ? Math.min(...stops) : t.length;
  const cut = t.startsWith('.', end) ? end + 1 : end;
  return t.slice(0, Math.max(cut, 1)).slice(0, MAX_QUOTE).trim();
}

/** The draft's flags: the quote check, then the draft's own. A draft with a blocking flag offers no proposal. */
function seal(base: TestDraft, plan: TestPlan, unsupported: boolean): TestDraft {
  const issues = draftIssues(base, plan);
  const blocking = [...(unsupported ? ['unsupported-quote'] : []), ...issues.blocking];
  const { proposal: _p, ...rest } = base;
  return { ...(blocking.length ? rest : base), qa: { blocking, advisory: issues.advisory } };
}

function rulesDraft(row: RcmRow, plan: TestPlan, found: FoundPassage[], runId: string, now: string): TestDraft {
  const seen = new Set<string>();
  const evidence: DraftEvidence[] = [];
  for (const f of found) {
    const key = `${f.documentId}#${f.page ?? ''}`;
    if (seen.has(key) || !firstSentence(f.text)) continue;
    seen.add(key);
    evidence.push({ documentId: f.documentId, ...(f.page === null ? {} : { page: f.page }), quote: firstSentence(f.text) });
  }
  const terms = plan.evidenceToRequest.join(', ');
  const docs = new Set(found.map((f) => f.documentId)).size;
  return seal({
    rowId: row.id, evidence,
    couldNotVerify: [found.length ? `Found ${found.length} passage${found.length === 1 ? '' : 's'} in ${docs} document${docs === 1 ? '' : 's'} for: ${terms}` : `Found no passages for: ${terms}`],
    confidence: 'low', qa: { blocking: [], advisory: [] }, draftedBy: { runId, at: now, model: 'rules' },
  }, plan, false);
}

/** The offline draft for every row to draft: what was found, quoted from the chunk text, and no proposal. */
export function draftEvidenceRules(e: Engagement, found: Record<string, FoundPassage[]>, runId: string, now: string): Record<string, TestDraft> {
  return Object.fromEntries(rowsToDraft(e).map((r) => [r.id, rulesDraft(r, e.testPlans[r.id], found[r.id] ?? [], runId, now)]));
}

/** Ids of this engagement's evidence documents that the reader may see and that have text. */
export async function evidenceDocumentIds(db: Executor, engagementId: string, user: User): Promise<Set<string>> {
  const docs = (await listDocuments(db, { engagementId, classifications: [...CLASSIFICATIONS_BY_ROLE[user.role]] }))
    .filter((d) => d.kind === 'evidence' && d.engagementId === engagementId && !d.retentionExpired);
  if (!docs.length) return new Set();
  const withText = await db.selectFrom('document_text').select('document_id').where('document_id', 'in', docs.map((d) => d.id)).execute();
  return new Set(withText.map((r) => r.document_id));
}

/** Words of the plan's requested evidence and the control title, as an either-or search (a long all-words query finds nothing). */
function queryFor(row: RcmRow, plan: TestPlan): string {
  const words = [...new Set([...plan.evidenceToRequest, row.control].join(' ').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  let q = '';
  for (const w of words) {
    const next = q ? `${q} or ${w}` : w;
    if (next.length > MAX_QUERY) break;
    q = next;
  }
  return q;
}

async function retrieve(o: DraftOptions, e: Engagement, row: RcmRow, plan: TestPlan, docIds: Set<string>): Promise<FoundPassage[]> {
  const query = queryFor(row, plan);
  if (!query) return [];
  const args = { query, limit: HITS_PER_ROW };
  const hits = (o.toolbox
    ? await o.toolbox.call('search_knowledge', args)
    : await searchKnowledge(o.db, o.user, e.id, { query, limit: HITS_PER_ROW }, { kinds: ['evidence'] })) as KnowledgeHit[];
  const chunks = hits.filter((h) => h.kind === 'chunk' && h.documentId && docIds.has(h.documentId));
  if (!chunks.length) return [];
  const rows = await o.db.selectFrom('chunks').select(['id', 'text']).where('id', 'in', chunks.map((h) => h.id)).execute();
  const text = new Map(rows.map((r) => [r.id, r.text]));
  return chunks.flatMap((h) => (text.has(h.id) ? [{ documentId: h.documentId!, page: h.page ?? null, text: text.get(h.id)! }] : []));
}

/** Reads one page (null: the whole text) of a document into `texts`, if it exists. */
async function loadPage(db: Executor, texts: Map<string, PageTexts>, documentId: string, page: number | null): Promise<void> {
  if (texts.get(documentId)?.byPage.has(page)) return;
  const whole = await documentPageText(db, documentId);
  if (!whole) return;
  const t = texts.get(documentId) ?? { pages: whole.pages, byPage: new Map<number | null, string>() };
  texts.set(documentId, t);
  if (page === null || !whole.pages) {
    t.byPage.set(null, whole.text);
    return;
  }
  if (page > whole.pages) return;
  const p = await documentPageText(db, documentId, page);
  if (p) t.byPage.set(page, p.text);
}

export function evidencePrompt(row: RcmRow, plan: TestPlan, found: FoundPassage[], shown: { documentId: string; page: number | null; text: string }[]): string {
  return [
    `Propose the result of testing this control from the evidence documents below. Cite each quote by documentId and page.`,
    asData('row', { id: row.id, control: row.control, objective: row.objective, risk: row.risk, frequency: row.frequency, sampleSize: row.sampleSize }),
    asData('plan', { attribute: plan.attribute, population: plan.population, sampleSize: plan.sampleSize, evidenceToRequest: plan.evidenceToRequest, procedure: plan.procedure }),
    asData('passages', found.map((f) => ({ documentId: f.documentId, page: f.page, text: f.text }))),
    asData('pages', shown),
  ].join('\n');
}

/** Drafts every row that needs one, in RCM order: find the passages, read the pages, ask the model, verify, run QA. */
export async function draftEvidenceWithModel(e: Engagement, o: DraftOptions): Promise<EvidenceDraftResult> {
  const now = (o.now ?? (() => new Date().toISOString()))();
  const out: EvidenceDraftResult = { drafts: {}, noDraft: [], withoutModel: false };
  const rows = rowsToDraft(e);
  if (!rows.length) return out;
  const docIds = await evidenceDocumentIds(o.db, e.id, o.user);
  for (const row of rows) {
    const plan = e.testPlans[row.id];
    const found = await retrieve(o, e, row, plan, docIds);
    if (!o.models?.available) {
      out.drafts[row.id] = rulesDraft(row, plan, found, o.runId, now);
      continue;
    }
    const texts = new Map<string, PageTexts>();
    const shown: { documentId: string; page: number | null; text: string }[] = [];
    let budget = MAX_SHOWN_CHARS;
    const keys = [...new Map(found.map((f) => [`${f.documentId}#${f.page ?? ''}`, f])).values()].slice(0, MAX_READ_PAGES);
    for (const f of keys) {
      await loadPage(o.db, texts, f.documentId, f.page);
      const text = texts.get(f.documentId)?.byPage.get(f.page) ?? '';
      shown.push({ documentId: f.documentId, page: f.page, text: text.slice(0, Math.max(budget, 0)) });
      budget -= text.length;
    }
    let model: { output: ModelDraft; servedModel: string };
    try {
      model = await o.models.generate('specialist', { system: EVIDENCE_SYSTEM, user: evidencePrompt(row, plan, found, shown), schema: ModelDraftSchema });
    } catch (err) {
      if (err instanceof AppError && err.code === 'BUDGET_EXHAUSTED') break;
      if (err instanceof ModelUnavailableError || err instanceof MalformedOutputError) {
        out.drafts[row.id] = rulesDraft(row, plan, found, o.runId, now);
        out.withoutModel = true;
        continue;
      }
      throw err;
    }
    for (const ev of model.output.evidence) {
      if (docIds.has(ev.documentId)) await loadPage(o.db, texts, ev.documentId, ev.page ?? null);
    }
    const checked = verifyDraft(model.output, texts, docIds);
    if (!checked.ok) {
      out.noDraft.push({ rowId: row.id, reason: checked.reason });
      continue;
    }
    const d = checked.draft;
    out.drafts[row.id] = seal({
      rowId: row.id,
      ...(d.proposal ? { proposal: d.proposal } : {}),
      evidence: d.evidence.map((x) => ({ documentId: x.documentId, ...(x.page === undefined ? {} : { page: x.page }), quote: x.quote })),
      couldNotVerify: d.couldNotVerify, confidence: d.confidence, qa: { blocking: [], advisory: [] },
      draftedBy: { runId: o.runId, at: now, model: model.servedModel },
    }, plan, checkQuotes(d, texts).length > 0);
  }
  return out;
}
