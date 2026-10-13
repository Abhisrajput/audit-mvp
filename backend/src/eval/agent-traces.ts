import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentConfig } from '../agents/config';
import { listGates } from '../agents/gate-repo';
import { LLM_POLICY_VERSION } from '../agents/policy/llm';
import { RULES_VERSION } from '../agents/policy/rules';
import { createRun, getRun, listSteps } from '../agents/run-repo';
import type { Action, Budget, Decision } from '../agents/types';
import { AgentWorker } from '../agents/worker';
import { DEV_USERS, ensureDevUsers } from '../auth/dev-users';
import { createMemoryDb } from '../db/pglite';
import type { LlmProvider } from '../engine/llm/provider';
import type { PackRegistry } from '../engine/packs';
import { canonicalJson } from '../engine/trail';
import { AuditService, type NewEngagement } from '../service';
import type { EvalCaseResult } from './harness';

// Agent golden traces (agent spec §8). Each scenario runs the agent offline on an eval engagement until its report
// gate opens, signing gates and recording field work the way people would. Its sequence of decisions must equal the
// golden trace stored with it. A change to the graph, the rules policy or a specialist that changes what the agent
// does shows up here. It is accepted only by regenerating the traces (npm run eval -- --update-traces) and reviewing the diff.

export const TRACES_DIR = path.resolve(__dirname, '../../eval/agent-traces');

export interface AgentScenario {
  id: string;
  description: string;
  engagement: NewEngagement;
  /** RCM rows whose recorded test finds exceptions; every other row passes. Each must be in the RCM the agent drafts. */
  failingControls: string[];
}

/** One decision, by what was done to what. Reasons are left out: they carry generated ids. */
export interface TraceEntry {
  type: Action['type'];
  subjectKey?: string;
  specialist?: string;
  mode?: 'review' | 'challenge';
  policy: Decision['policy'];
}

export interface TraceFile {
  scenario: AgentScenario;
  trace: TraceEntry[];
}

export function traceEntry(d: Decision): TraceEntry {
  const a = d.action;
  return {
    type: a.type,
    ...('subjectKey' in a ? { subjectKey: a.subjectKey } : {}),
    ...('specialist' in a ? { specialist: a.specialist } : {}),
    ...(a.type === 'request_qa' ? { mode: a.mode } : {}),
    policy: d.policy,
  };
}

/** Where two traces first differ, or null when they are the same. */
export function traceDifference(expected: TraceEntry[], actual: TraceEntry[]): string | null {
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const want = canonicalJson(expected[i] ?? null);
    const got = canonicalJson(actual[i] ?? null);
    if (want !== got) return `decision ${i + 1}: expected ${want}, got ${got}`;
  }
  return null;
}

export interface ScenarioOutcome {
  trace: TraceEntry[];
  reachedReportGate: boolean;
  detail: string;
}

const MAX_ROUNDS = 30;

/**
 * The budget of an informational model-driven run (--agent-llm). The model drafts, reviews and decides throughout such
 * a run, so a production budget ($25) per scenario would make every such eval costly. A run that runs out stops at
 * needs_human (budget_exhausted), which is reported like any other outcome.
 */
export const INFORMATIONAL_LLM_BUDGET: Budget = { ...defaultAgentConfig().budget, maxCostUsd: 2, maxTokens: 200_000 };

/**
 * Runs one scenario on its own in-process database. With `llm`, the model policy decides (informational runs only).
 * `budget` defaults to a production run's.
 */
export async function runAgentScenario(registry: PackRegistry, scenario: AgentScenario, llm: LlmProvider | null = null, budget?: Budget): Promise<ScenarioOutcome> {
  const db = await createMemoryDb();
  try {
    // Orchestration is under test here, not citation trust, which has its own tests: unverified packs are allowed.
    const svc = new AuditService(db, registry, llm, { citationPolicy: { allowUnverified: true } });
    await ensureDevUsers(db.kysely);
    const [auditor, reviewer, approver] = DEV_USERS;
    const e = await svc.createEngagement(scenario.engagement, auditor);
    const cfg = defaultAgentConfig();
    const run = await createRun(db.kysely, {
      engagementId: e.id, startedBy: auditor.id, policy: llm ? 'llm' : 'rules', policyVersion: llm ? LLM_POLICY_VERSION : RULES_VERSION, budget: budget ?? cfg.budget,
    });
    const worker = new AgentWorker(svc, cfg, { id: `eval-${scenario.id}` });
    const unattended = { unattended: 'test' } as const;
    let reached = false;
    let detail = '';
    for (let round = 0; round < MAX_ROUNDS && !reached && !detail; round++) {
      await worker.drain();
      const now = (await getRun(db.kysely, run.id))!;
      const reason = now.statusReason;
      const open = (await listGates(db.kysely, e.id)).filter((g) => g.state === 'open');
      if (now.status !== 'waiting') {
        detail = `the run stopped: ${now.status} (${reason})`;
      } else if (reason === 'awaiting report gate signature') {
        reached = true;
      } else if (reason === 'awaiting scope gate signature' || reason === 'awaiting rcm gate signature') {
        for (const g of open) await svc.signGate(g.id, 'approve', '', reviewer, unattended);
      } else if (reason.startsWith('awaiting test results')) {
        const eng = await svc.engagement(e.id);
        const missing = scenario.failingControls.filter((id) => !eng.rcm.some((r) => r.id === id));
        if (missing.length) {
          detail = `failing control(s) ${missing.join(', ')} are not in the RCM the agent drafted; choose controls its scope includes`;
          break;
        }
        for (const r of eng.rcm) {
          const fails = scenario.failingControls.includes(r.id);
          await svc.recordTest(e.id, r.id, {
            designAdequate: true, observation: fails ? 'Exceptions found in the sample.' : 'All items reviewed without exception.',
            evidenceRefs: ['EV-1'], sampleTested: r.sampleSize, exceptions: fails ? 2 : 0,
          }, auditor);
        }
      } else if (reason.startsWith('awaiting finding gate signature')) {
        for (const g of open.filter((x) => x.kind === 'finding')) {
          await svc.signOff(e.id, g.subjectId, 'review', '', reviewer, {}, unattended);
          await svc.signOff(e.id, g.subjectId, 'approve', '', approver, {}, unattended);
        }
      } else {
        detail = `the run is waiting: ${reason}`;
      }
    }
    if (!reached && !detail) detail = `the run did not reach its report gate within ${MAX_ROUNDS} rounds`;
    const trace = (await listSteps(db.kysely, run.id)).filter((s) => s.kind === 'decision').map((s) => traceEntry(s.decision as Decision));
    return { trace, reachedReportGate: reached, detail: reached ? `reached the report gate in ${trace.length} decisions` : detail };
  } finally {
    await db.close();
  }
}

export function loadTraceFiles(dir = TRACES_DIR): { file: string; data: TraceFile }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: path.join(dir, f), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TraceFile }));
}

export interface TraceOptions {
  /** Rewrite each golden trace from this run (after a reviewed change in behaviour). */
  update?: boolean;
  dir?: string;
  /** Only scenarios using one of these packs. */
  packIds?: string[];
  /**
   * Also run each scenario with this model and report where its decisions differ from the rules (informational, spec
   * §11). Paid: the command line passes it only with --agent-llm.
   */
  llm?: LlmProvider | null;
  /** How a scenario is run; tests replace it. */
  runScenario?: ScenarioRunner;
}

export type ScenarioRunner = (registry: PackRegistry, scenario: AgentScenario, llm: LlmProvider | null, budget?: Budget) => Promise<ScenarioOutcome>;

export async function runAgentTraces(registry: PackRegistry, o: TraceOptions = {}): Promise<EvalCaseResult[]> {
  const results: EvalCaseResult[] = [];
  // A missing directory (a build that did not ship the traces) must not pass for "no traces to check".
  const dir = o.dir ?? TRACES_DIR;
  if (!fs.existsSync(dir)) {
    return [{ id: 'agent:traces-missing', packId: 'agent', kind: 'agent-trace', description: 'Agent golden traces are present', passed: false, detail: `the traces directory does not exist: ${dir}` }];
  }
  const run = o.runScenario ?? runAgentScenario;
  for (const { file, data } of loadTraceFiles(o.dir)) {
    const s = data.scenario;
    if (o.packIds && !s.engagement.packIds.some((p) => o.packIds!.includes(p))) continue;
    const base = { id: `agent:${s.id}`, packId: s.engagement.packIds[0], kind: 'agent-trace' as const, description: s.description };
    let rules: TraceEntry[] | null = null;
    try {
      const out = await run(registry, s, null);
      if (!out.reachedReportGate) {
        results.push({ ...base, passed: false, detail: out.detail });
      } else if (o.update) {
        fs.writeFileSync(file, `${JSON.stringify({ scenario: s, trace: out.trace }, null, 2)}\n`);
        results.push({ ...base, passed: true, detail: `golden trace rewritten: ${out.trace.length} decisions` });
        rules = out.trace;
      } else {
        const diff = traceDifference(data.trace, out.trace);
        results.push({ ...base, passed: diff === null, detail: diff ?? out.detail });
        rules = out.trace;
      }
    } catch (err) {
      results.push({ ...base, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
    // The model-driven run is informational: it has its own case, kept out of the totals, and its own error handling,
    // so nothing in it can fail the golden case above.
    if (o.llm && rules) {
      const info = { id: `agent-llm:${s.id}`, packId: base.packId, kind: 'agent-trace-llm' as const, description: `${s.description} (model-driven, informational)`, informational: true };
      try {
        const model = await run(registry, s, o.llm, INFORMATIONAL_LLM_BUDGET);
        const diff = traceDifference(rules, model.trace);
        results.push({ ...info, passed: model.reachedReportGate, detail: `${model.detail}; ${diff ? `first difference from the rules: ${diff}` : 'the same decisions as the rules'}` });
      } catch (err) {
        results.push({ ...info, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  return results;
}
