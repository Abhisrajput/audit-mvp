import { api } from './api';
import type { Action, AgentRun, AgentStep, Budget, Decision, DelegateRecord, Engagement, Finding, Gate, GateKind, QaReport, Role, RunStatus, TestPlan, User } from './types';

// The agent run as the UI shows it (agent spec §7.2). Everything here is plain functions over the API's types, so it is
// tested without a browser; the components only lay it out.

export interface AgentSettings {
  enabled: boolean;
  /** The most a run may have; a starter may ask for less. */
  budget: Budget;
  qaThreshold: number;
  policy: 'llm' | 'rules';
}

export interface RunPage {
  run: AgentRun;
  steps: AgentStep[];
}

export interface StartedRun {
  run: AgentRun;
  warnings: string[];
}

export type TestPlanPatch = Partial<Pick<TestPlan, 'attribute' | 'population' | 'sampleSize' | 'selectionMethod' | 'evidenceToRequest' | 'procedure' | 'notTestedJustification'>>;

/** The most steps one GET /api/runs/:id returns (the server's limit). */
export const STEP_PAGE = 500;

export const agentApi = {
  settings: () => api<AgentSettings>('/agents/settings'),
  runs: (engagementId: string) => api<AgentRun[]>(`/engagements/${engagementId}/runs`),
  steps: (runId: string, afterSeq: number) => api<RunPage>(`/runs/${runId}?afterSeq=${afterSeq}&limit=${STEP_PAGE}`),
  gates: (engagementId: string) => api<Gate[]>(`/engagements/${engagementId}/gates`),
  start: (engagementId: string, budget: Partial<Budget>) => api<StartedRun>(`/engagements/${engagementId}/runs`, { method: 'POST', body: { budget } }),
  pause: (runId: string) => api<AgentRun>(`/runs/${runId}/pause`, { method: 'POST', body: {} }),
  resume: (runId: string) => api<AgentRun>(`/runs/${runId}/resume`, { method: 'POST', body: {} }),
  cancel: (runId: string) => api<AgentRun>(`/runs/${runId}/cancel`, { method: 'POST', body: {} }),
  raiseBudget: (runId: string, budget: Budget) => api<AgentRun>(`/runs/${runId}/budget`, { method: 'POST', body: budget }),
  editTestPlan: (engagementId: string, rowId: string, patch: TestPlanPatch, version: number | undefined) =>
    api<TestPlan>(`/engagements/${engagementId}/test-plans/${rowId}`, { method: 'PUT', body: patch, ifMatch: version }),
};

/** 'YYYY-MM-DD HH:MM UTC', as elsewhere in the app. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// ---------- The run ----------

const ENDED: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];
export const hasEnded = (run: AgentRun) => ENDED.includes(run.status);

/** The run to show: the engagement's live run, else its latest (runs come newest first). */
export function currentRun(runs: AgentRun[]): AgentRun | null {
  return runs.find((r) => !hasEnded(r)) ?? runs[0] ?? null;
}

/**
 * How soon to look again, or null to stop. Often while the agent works, slowly while it waits for people, and slowly with no
 * live run too (a colleague may start one). Polling stops only once the latest run has ended and no gate is left open.
 */
export function pollDelayMs(run: AgentRun | null, hasOpenGate: boolean): number | null {
  if (!run) return 15000;
  if (hasEnded(run)) return hasOpenGate ? 15000 : null;
  return run.status === 'running' || run.status === 'runnable' ? 3000 : 15000;
}

export const STATUS_CHIP: Record<RunStatus, { label: string; color: 'default' | 'primary' | 'info' | 'warning' | 'success' | 'error' }> = {
  running: { label: 'Working', color: 'primary' },
  runnable: { label: 'Queued', color: 'info' },
  waiting: { label: 'Waiting', color: 'default' },
  needs_human: { label: 'Needs a person', color: 'warning' },
  completed: { label: 'Completed', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'default' },
  failed: { label: 'Failed', color: 'error' },
};

/** The run's reason in plain words, and what a person can do about it (null when nothing is needed). */
export function explainStatus(run: AgentRun): { text: string; next: string | null } {
  const r = run.statusReason;
  if (run.status === 'running') return { text: 'The agent is working on the engagement.', next: null };
  if (run.status === 'runnable') return { text: 'Queued: a worker picks the run up within a few seconds.', next: null };
  if (run.status === 'completed') return { text: 'The run reached the end of the chain: the report gate was approved.', next: null };
  if (run.status === 'cancelled') return { text: 'The run was cancelled.', next: 'Start a new run to continue with the agent.' };
  if (run.status === 'failed') return { text: `The run failed: ${r || 'no reason recorded'}.`, next: 'Start a new run once the cause is fixed.' };
  if (r === 'paused_by_user') return { text: 'Paused.', next: 'Resume the run when you are ready.' };
  if (r.startsWith('awaiting test results')) {
    return {
      text: `Waiting for field work: ${r.replace(/^awaiting /, '')}.`,
      next: 'Record each test in Fieldwork & testing, or give a reason not to test it in Test plans. The run moves on by itself.',
    };
  }
  if (/^awaiting .* gate signature/.test(r)) return { text: `Waiting for a signature: ${r.replace(/^awaiting /, '')}.`, next: 'The signer approves or rejects the open gate below.' };
  if (r.startsWith('awaiting signatures on reviewed findings')) {
    return { text: 'Waiting for reviewed findings to be approved or rejected before they can be redrafted.', next: 'The Chief Audit Executive approves or rejects them in Findings.' };
  }
  if (r === 'engagement being edited') return { text: 'Someone is editing the engagement, so the agent is backing off.', next: 'It tries again within a minute.' };
  if (r.startsWith('budget_exhausted')) return { text: `The run used its budget (${r.replace(/^budget_exhausted: /, '')}).`, next: 'An audit manager can raise the budget; the run then resumes.' };
  if (r.startsWith('gate_rejected_twice')) {
    return { text: `A gate was rejected twice (${subjectLabel(r.replace(/^gate_rejected_twice: /, ''))}).`, next: 'Edit the workpaper by hand, then resume: it goes through QA and a fresh gate.' };
  }
  if (r.startsWith('agent_forbidden')) return { text: `The rails refused an action: ${r.replace(/^agent_forbidden: /, '')}`, next: 'Check the steps below, then resume or cancel.' };
  if (r.startsWith('error:')) return { text: `The run stopped after repeated errors: ${r.replace(/^error: /, '')}`, next: 'Resume to try again; if it keeps failing, give the run id to your administrator.' };
  if (run.status === 'needs_human') return { text: r || 'The agent needs a person to decide.', next: 'Fix what it asks for, then resume.' };
  return { text: r ? `Waiting: ${r}.` : 'Waiting.', next: null };
}

export interface SpendRow {
  label: string;
  used: string;
  limit: string;
  /** 0–100, capped. */
  pct: number;
}

const whole = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Spent against budget. An iteration is one decision and what it led to, so it usually writes two or more steps. */
export function spendRows(run: AgentRun): SpendRow[] {
  const pct = (used: number, max: number) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100);
  const tokens = run.spent.tokensIn + run.spent.tokensOut;
  return [
    { label: 'Iterations', used: whole(run.spent.steps), limit: whole(run.budget.maxSteps), pct: pct(run.spent.steps, run.budget.maxSteps) },
    { label: 'Model tokens', used: whole(tokens), limit: whole(run.budget.maxTokens), pct: pct(tokens, run.budget.maxTokens) },
    { label: 'Model cost', used: usd(run.spent.costUsd), limit: usd(run.budget.maxCostUsd), pct: pct(run.spent.costUsd, run.budget.maxCostUsd) },
  ];
}

// ---------- Steps ----------

const SUBJECTS: Record<string, string> = { scope: 'scope', rcm: 'RCM', test_plans: 'test plans', testing: 'test conclusions', gaps: 'findings', report: 'report' };

/** A subject key in words: 'scope', 'RCM', 'finding for FD-HACCP-03', … */
export function subjectLabel(key: string): string {
  if (key.startsWith('finding:')) return `finding for ${key.slice('finding:'.length)}`;
  return SUBJECTS[key] ?? key;
}

/** What an action does, in words. */
export function actionLabel(a: Action): string {
  switch (a.type) {
    case 'delegate':
      return `Draft the ${subjectLabel(a.subjectKey)}${a.rows?.length ? ` (${a.rows.join(', ')})` : ''}`;
    case 'rework':
      return `Redraft the ${subjectLabel(a.subjectKey)} from feedback`;
    case 'request_qa':
      return a.mode === 'challenge' ? `Challenge the ${subjectLabel(a.subjectKey)}` : `QA review of the ${subjectLabel(a.subjectKey)}`;
    case 'open_gate':
      return `Open the ${subjectLabel(a.subjectKey)} gate`;
    case 'wait':
      return `Wait: ${a.reason}`;
    case 'escalate':
      return `Hand over to a person: ${a.reason}`;
    case 'complete':
      return 'Complete the run';
  }
}

const FALLBACK_WHY: Record<string, string> = {
  off_menu: 'the model chose an action that is not allowed',
  malformed: 'the model answered in the wrong shape',
  model_error: 'the model was unavailable',
  chosen: "the model's choice was refused",
};

/** Why the rules decided instead of the model, or null (an offline run's rules, and the model's own choices, are not fallbacks). */
export function fallbackOf(d: Decision): string | null {
  if (d.policy !== 'rules' || !d.attempts?.length) return null;
  return FALLBACK_WHY[d.attempts[d.attempts.length - 1].outcome];
}

export interface StepView {
  title: string;
  detail: string | null;
  /** Who chose a decision: the model, the rules, or nobody (one allowed action). Null for other steps. */
  policy: Decision['policy'] | null;
  fallback: string | null;
  /** Drafted or reviewed without the model, which was configured but unavailable. */
  withoutModel: boolean;
  /** A refusal by the rails, or of a lookup a model asked for. */
  refused: boolean;
}

/** One step of the run as the timeline shows it, from the step's typed record. */
export function describeStep(step: AgentStep): StepView {
  const plain = { detail: null, policy: null, fallback: null, withoutModel: false, refused: false };
  switch (step.kind) {
    case 'decision': {
      const d = step.decision as Decision;
      return { ...plain, title: actionLabel(d.action), detail: d.rationale || null, policy: d.policy, fallback: fallbackOf(d) };
    }
    case 'delegate': {
      const d = step.decision as DelegateRecord;
      const what = d.action.type === 'rework' ? 'Redrafted' : 'Drafted';
      return {
        ...plain,
        title: `${what} the ${subjectLabel(d.action.subjectKey)} (${d.action.specialist} specialist)`,
        detail: d.action.type === 'rework' ? `Instruction: ${d.action.instruction}` : null,
        withoutModel: !!d.withoutModel,
      };
    }
    case 'qa': {
      const q = step.decision as QaReport;
      const blocking = q.issues.filter((i) => i.severity === 'blocking').length;
      return {
        ...plain,
        title: `QA ${q.mode === 'challenge' ? 'challenge' : 'review'} of the ${subjectLabel(q.subjectKey)}: ${q.score}/100`,
        detail: q.issues.length ? `${q.issues.length} issue(s), ${blocking} blocking` : 'No issues',
        withoutModel: !!q.withoutModel,
      };
    }
    case 'tool_call': {
      const t = step.decision as { tool?: string; kind?: GateKind; attempt?: number; resultIds?: string[]; refused?: string; recovered?: string };
      if (t.recovered) return { ...plain, title: 'Took over from a worker that stopped mid-step', detail: t.recovered };
      if (t.tool === 'open_gate') return { ...plain, title: `Opened the ${t.kind} gate${t.attempt && t.attempt > 1 ? ` (attempt ${t.attempt})` : ''}` };
      if (t.refused) return { ...plain, title: step.agent === 'rails' ? 'Refused by the rails' : 'Refused a lookup the model asked for', detail: t.refused, refused: true };
      return { ...plain, title: `Looked up the knowledge base (${t.tool})`, detail: `${t.resultIds?.length ?? 0} result(s)` };
    }
  }
}

/** Every step after `afterSeq`, page by page (a page holds at most STEP_PAGE steps). */
export async function loadStepsSince(page: (afterSeq: number) => Promise<AgentStep[]>, afterSeq: number): Promise<AgentStep[]> {
  const out: AgentStep[] = [];
  let after = afterSeq;
  for (;;) {
    const steps = await page(after);
    out.push(...steps);
    if (steps.length < STEP_PAGE) return out;
    after = steps[steps.length - 1].seq;
  }
}

/** New steps that changed the engagement itself: the page reloads it, or a person's next save is refused as stale. */
export const changedEngagement = (steps: AgentStep[]) => steps.some((s) => s.kind === 'delegate');

// ---------- Gates ----------

/** Open gates first, then decided ones newest first. Superseded gates (changed before anyone signed) are only counted. */
export function sortGates(gates: Gate[]): { open: Gate[]; decided: Gate[]; superseded: number } {
  return {
    open: gates.filter((g) => g.state === 'open'),
    decided: gates.filter((g) => g.state === 'approved' || g.state === 'rejected').reverse(),
    superseded: gates.filter((g) => g.state === 'superseded').length,
  };
}

/** Who signs each workpaper gate (spec §4.3). Finding gates close through the finding's own review and approval. */
export const GATE_SIGNER: Record<Exclude<GateKind, 'finding'>, Role> = { scope: 'audit_manager', rcm: 'audit_manager', report: 'cae' };

export interface GateSigning {
  /** This person may approve or reject the gate here. */
  canSign: boolean;
  /** Why not; or, when they can, how signing works. */
  note: string;
}

/** Whether this person can sign this gate now, and if not, why. The server checks all of it again. */
export function gateSigning(gate: Gate, user: User | null, runs: AgentRun[]): GateSigning {
  if (gate.state !== 'open') return { canSign: false, note: `This gate is ${gate.state}.` };
  if (gate.kind === 'finding') {
    return { canSign: false, note: 'Review and approve this finding in the Findings tab: an audit manager reviews it, then the Chief Audit Executive approves or rejects it.' };
  }
  const signer = GATE_SIGNER[gate.kind];
  const run = runs.find((r) => r.id === gate.runId);
  if (run && hasEnded(run)) return { canSign: false, note: `The run behind this gate has ended (${run.status}), so it can no longer be signed.` };
  if (!user || user.role !== signer) return { canSign: false, note: `Awaiting signature by ${signer === 'cae' ? 'the Chief Audit Executive' : 'an audit manager'}.` };
  if (run?.startedBy === user.id) return { canSign: false, note: 'You started this run, so someone else must sign its gates.' };
  return { canSign: true, note: 'Signing opens a window where you confirm your identity again.' };
}

/** The open gate on a finding, if the agent opened one. */
export const openFindingGate = (gates: Gate[], findingId: string): Gate | null =>
  gates.find((g) => g.kind === 'finding' && g.state === 'open' && g.subjectId === findingId) ?? null;

/** QA scored the subject below the threshold. The gate still opened because no issue was blocking, so the signer is told. */
export const belowThreshold = (report: QaReport | null, threshold: number) => !!report && report.score < threshold;

/** The backend's canonical JSON (engine/trail.ts): keys sorted, undefined dropped. Kept identical so hashes agree. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The finding's content hash as the server computes it (signing/content-hash.ts): what a gate on the finding was reviewed against. */
export async function findingContentHash(f: Finding): Promise<string> {
  const { id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs } = f;
  const bytes = new TextEncoder().encode(canonicalJson({ id, rowId, controlId, title, rating, condition, criteria, cause, effect, recommendation, citations, evidenceRefs }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether the gate's QA review is of the finding as it stands. `currentHash` is null until it is computed; then nothing is shown. */
export const reviewIsCurrent = (gate: Gate, currentHash: string | null): boolean => currentHash !== null && gate.subjectHash === currentHash;

// ---------- Forms ----------

export const BUDGET_LABEL: Record<keyof Budget, string> = { maxSteps: 'Iterations', maxTokens: 'Model tokens', maxCostUsd: 'Model cost (USD)' };

/** What is wrong with a budget a person typed, or null. `max` is the ceiling when starting; `min` the current budget when raising. */
export function budgetProblem(next: Budget, bounds: { min?: Budget; max?: Budget }): string | null {
  for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
    const v = next[k];
    const money = k === 'maxCostUsd';
    if (!Number.isFinite(v) || v <= 0 || (!money && !Number.isInteger(v))) return `${BUDGET_LABEL[k]} must be a positive ${money ? 'number' : 'whole number'}`;
    if (bounds.max && v > bounds.max[k]) return `${BUDGET_LABEL[k]} may not exceed ${bounds.max[k]}`;
    if (bounds.min && v < bounds.min[k]) return `${BUDGET_LABEL[k]} can only be raised (it is ${bounds.min[k]})`;
  }
  return null;
}

/** RCM rows still waiting for a recorded test or a person's reason not to test, counted as the run's wait condition counts them. */
export function rowsAwaitingTests(e: Engagement): string[] {
  return e.rcm.filter((r) => !e.testInputs[r.id] && !e.testPlans[r.id]?.notTestedJustification?.trim()).map((r) => r.id);
}

/** A test plan as its form holds it: numbers and lists as text. */
export interface PlanDraft {
  attribute: string;
  population: string;
  sampleSize: string;
  selectionMethod: TestPlan['selectionMethod'];
  /** One item per line. */
  evidenceToRequest: string;
  procedure: string;
  notTestedJustification: string;
}

export const planDraft = (p: TestPlan): PlanDraft => ({
  attribute: p.attribute, population: p.population, sampleSize: String(p.sampleSize), selectionMethod: p.selectionMethod,
  evidenceToRequest: p.evidenceToRequest.join('\n'), procedure: p.procedure, notTestedJustification: p.notTestedJustification ?? '',
});

/** The fields a person changed, as the API takes them, or what is wrong with the form. An empty reason clears it. */
export function planPatch(before: TestPlan, d: PlanDraft): { patch: TestPlanPatch } | { problem: string } {
  const sampleSize = Number(d.sampleSize);
  if (d.sampleSize.trim() === '' || !Number.isInteger(sampleSize) || sampleSize < 0) return { problem: 'Sample size must be a whole number, 0 or more' };
  for (const [k, label] of [['attribute', 'Attribute'], ['population', 'Population'], ['procedure', 'Procedure']] as const) {
    if (!d[k].trim()) return { problem: `${label} cannot be empty` };
  }
  const next: Required<TestPlanPatch> = {
    attribute: d.attribute.trim(), population: d.population.trim(), sampleSize, selectionMethod: d.selectionMethod,
    evidenceToRequest: d.evidenceToRequest.split('\n').map((s) => s.trim()).filter(Boolean), procedure: d.procedure.trim(),
    notTestedJustification: d.notTestedJustification.trim(),
  };
  const patch: TestPlanPatch = {};
  for (const k of Object.keys(next) as (keyof TestPlanPatch)[]) {
    const old = k === 'notTestedJustification' ? before.notTestedJustification ?? '' : before[k];
    if (JSON.stringify(old) !== JSON.stringify(next[k])) Object.assign(patch, { [k]: next[k] });
  }
  return { patch };
}
