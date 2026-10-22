import { runAgentTraces } from './agent-traces';
import { runJudgmentCases } from './judgment';
import { createMemoryDb } from '../db/pglite';
import type { LlmProvider } from '../engine/llm/provider';
import type { PackRegistry } from '../engine/packs';
import { STRICT_CITATIONS, type CitationPolicy } from '../engine/trust';
import type { ContentPack, EvalCase } from '../engine/types';
import type { User } from '../engine/types';
import { AuditService, ENGINE_VERSION } from '../service';

// Evaluation harness: replays expert-labelled cases from each content pack
// through the real modules and gates. Its report doubles as test evidence in
// the validation package (OQ-style), and is how a model or prompt change is
// qualified before release.

export interface EvalCaseResult {
  id: string;
  packId: string;
  kind: EvalCase['kind'] | 'agent-trace' | 'agent-trace-llm' | 'judgment';
  description: string;
  passed: boolean;
  /** Reported for information only, and left out of the totals: a model-driven agent run (--agent-llm). */
  informational?: boolean;
  detail: string;
}

export interface EvalReport {
  id: string;
  at: string;
  provider: { id: string; model: string };
  engineVersion: string;
  packVersions: Record<string, string>;
  /** Optional: stored reports from before the trust rules (REQ-22) have none. */
  citationPolicy?: CitationPolicy;
  total: number;
  passed: number;
  byKind: Record<string, { total: number; passed: number }>;
  cases: EvalCaseResult[];
}

interface TestCaseInput {
  controlId: string;
  designAdequate: boolean | null;
  observation: string;
  evidenceRefs: string[];
  sampleTested: number;
  exceptions: number;
}

async function runFieldCase(svc: AuditService, registry: PackRegistry, input: TestCaseInput, withGaps: boolean) {
  const auditor: User = { id: 'eval', name: 'Evaluation harness', role: 'auditor' };
  const control = registry.controls.get(input.controlId);
  if (!control) throw new Error(`Eval case references unknown control ${input.controlId}`);
  const e = await svc.createEngagement(
    { name: 'eval', entity: 'eval', site: 'eval', periodFrom: '2026-01-01', periodTo: '2026-06-30', auditType: 'eval', scopeStatement: control.title, packIds: [control.packId] },
    auditor,
  );
  await svc.runModule(e.id, 'scope', auditor);
  const scoped = await svc.engagement(e.id);
  await svc.setScope(e.id, scoped.scope.map((s) => ({ controlId: s.controlId, included: s.controlId === input.controlId })), auditor);
  await svc.runModule(e.id, 'rcm', auditor);
  await svc.recordTest(e.id, input.controlId, { designAdequate: input.designAdequate, observation: input.observation, evidenceRefs: input.evidenceRefs, sampleTested: input.sampleTested, exceptions: input.exceptions }, auditor);
  await svc.runModule(e.id, 'testing', auditor);
  if (withGaps) await svc.runModule(e.id, 'gaps', auditor);
  return svc.engagement(e.id);
}

async function runCase(registry: PackRegistry, svc: AuditService, pack: ContentPack, c: EvalCase): Promise<EvalCaseResult> {
  const base = { id: c.id, packId: pack.id, kind: c.kind, description: c.description };
  try {
    if (c.kind === 'retrieval') {
      const k = Number(c.expected.k ?? 5);
      const packIds = (c.input.packIds as string[] | undefined) ?? [pack.id];
      const allowed = new Set(registry.clausesFor(packIds).map((x) => x.id));
      const hits = svc.grounding.clauses.search(String(c.input.query), k, (id) => allowed.has(id)).map((h) => h.clauseId);
      const expected = c.expected.clauseIds as string[];
      const missing = expected.filter((id) => !hits.includes(id));
      return { ...base, passed: missing.length === 0, detail: missing.length ? `Missing from top ${k}: ${missing.join(', ')} (got ${hits.join(', ')})` : `All expected clauses in top ${k}` };
    }
    const input = c.input as unknown as TestCaseInput;
    const e = await runFieldCase(svc, registry, input, c.kind === 'gaps');
    if (c.kind === 'testing') {
      const got = e.testResults[input.controlId]?.conclusion;
      return { ...base, passed: got === c.expected.conclusion, detail: `expected ${c.expected.conclusion}, got ${got}` };
    }
    const f = e.findings.find((x) => x.rowId === input.controlId);
    const problems: string[] = [];
    if (c.expected.finding === false) {
      if (f) problems.push('a finding was raised but none expected');
    } else {
      if (!f) problems.push('no finding raised');
      if (f && c.expected.status && f.status !== c.expected.status) problems.push(`status ${f.status} != ${c.expected.status}`);
      for (const id of (c.expected.mustCite as string[] | undefined) ?? []) {
        if (f && !f.citations.some((x) => x.clauseId === id)) problems.push(`does not cite ${id}`);
      }
      if (f && c.expected.rating && f.rating !== c.expected.rating) problems.push(`rating ${f.rating} != ${c.expected.rating}`);
    }
    return { ...base, passed: problems.length === 0, detail: problems.join('; ') || 'finding matches expectations' };
  } catch (err) {
    return { ...base, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The eval command line: `[--provider anthropic] [--packs food,pharma] [--update-traces] [--agent-llm]`. */
export function evalArgs(args: string[]): { provider: string; packs?: string[]; updateTraces: boolean; agentLlm: boolean } {
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { provider: arg('provider') ?? 'offline', packs: arg('packs')?.split(','), updateTraces: args.includes('--update-traces'), agentLlm: args.includes('--agent-llm') };
}

/** Totals over the cases that count: informational ones are reported but never counted. */
export function tallyCases(cases: EvalCaseResult[]): Pick<EvalReport, 'total' | 'passed' | 'byKind'> {
  const counted = cases.filter((c) => !c.informational);
  const byKind: EvalReport['byKind'] = {};
  for (const r of counted) {
    byKind[r.kind] ??= { total: 0, passed: 0 };
    byKind[r.kind].total++;
    if (r.passed) byKind[r.kind].passed++;
  }
  return { total: counted.length, passed: counted.filter((c) => c.passed).length, byKind };
}

// `agentTraces` runs the agent's golden traces, offline. Only the command line asks for it. `agentLlm` adds a
// model-driven run per scenario with `llm` (informational and paid), so it takes an explicit --agent-llm; the HTTP
// route asks for neither.
export async function runEval(
  registry: PackRegistry, llm: LlmProvider | null, packIds?: string[], policy: CitationPolicy = STRICT_CITATIONS,
  opts: { agentTraces?: boolean; updateTraces?: boolean; agentLlm?: boolean } = {},
): Promise<EvalReport> {
  // A throwaway in-process database: eval never touches operational data or the trail.
  const db = await createMemoryDb();
  try {
    const svc = new AuditService(db, registry, llm, { citationPolicy: policy });
    const packs = registry.list().filter((p) => !packIds || packIds.includes(p.id));
    const cases: EvalCaseResult[] = [];
    for (const pack of packs) {
      for (const c of pack.evalCases) cases.push(await runCase(registry, svc, pack, c));
    }
    // The judgment rules' draft cases (no pack, no model): always run.
    cases.push(...runJudgmentCases());
    // The agent's golden traces (agent spec §8), offline, each on its own in-process database.
    if (opts.agentTraces) cases.push(...(await runAgentTraces(registry, { update: opts.updateTraces, packIds, llm: opts.agentLlm ? llm : null })));
    return {
      id: `EVAL-${Date.now()}`,
      at: new Date().toISOString(),
      provider: svc.providerInfo,
      engineVersion: ENGINE_VERSION,
      packVersions: Object.fromEntries(packs.map((p) => [p.id, p.version])),
      citationPolicy: policy,
      ...tallyCases(cases),
      cases,
    };
  } finally {
    await db.close();
  }
}

export function evalMarkdown(r: EvalReport): string {
  return [
    `# Evaluation report ${r.id}`,
    ``,
    `- Run at: ${r.at}`,
    `- Provider: ${r.provider.id} / ${r.provider.model}`,
    `- Engine: ${r.engineVersion}; packs: ${Object.entries(r.packVersions).map(([k, v]) => `${k}@${v}`).join(', ')}`,
    `- Unverified citations: ${r.citationPolicy?.allowUnverified ? 'allowed with a warning (not valid for release)' : 'blocked'}`,
    `- Result: **${r.passed}/${r.total} passed**`,
    ``,
    `| Kind | Passed |`,
    `|---|---|`,
    ...Object.entries(r.byKind).map(([k, v]) => `| ${k} | ${v.passed}/${v.total} |`),
    ``,
    `| Case | Pack | Kind | Result | Detail |`,
    `|---|---|---|---|---|`,
    ...r.cases.map((c) => `| ${c.id} | ${c.packId} | ${c.kind} | ${c.informational ? 'INFO' : c.passed ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`),
  ].join('\n');
}
