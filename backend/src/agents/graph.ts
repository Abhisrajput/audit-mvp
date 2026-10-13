import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement } from '../engine/types';
import { findingKey, rowBasis, subjectInfo } from './subjects';
import { MAX_REJECTIONS, MAX_SELF_REWORKS, type Action, type GateRecord, type GraphInput, type Menu, type QaReport, type Specialist, type Stage } from './types';

// The engagement graph (spec §4): a pure function from the engagement, its gates and this run's QA and redraft
// history to the actions the supervisor may take next. Nothing here reads or writes the database.
//
// Chain: scope ─QA─▶ [scope gate] ─▶ rcm ─QA─▶ [rcm gate] ─▶ test plans ─QA─▶ (wait for field work) ─▶ testing
//        ─▶ gaps ─▶ each finding ─QA─▶ [finding gate] ─▶ report ─QA─▶ [report gate] ─▶ complete

const FAILED = new Set(['Ineffective', 'Design deficient']);

type Step = { passed: true } | { passed: false; actions: Action[]; qa: QaReport | null };
const act = (actions: Action[], qa: QaReport | null = null): Step => ({ passed: false, actions, qa });

function findLast<T>(xs: readonly T[], match: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (match(xs[i])) return xs[i];
  return undefined;
}

/** The latest gate for a subject that still counts: a superseded gate was overtaken by a change before anyone signed it. */
const latestGate = (gates: readonly GateRecord[], key: string) => findLast(gates, (g) => g.subjectKey === key && g.state !== 'superseded');
export const latestGateId = (gates: readonly GateRecord[], key: string): string | null => latestGate(gates, key)?.id ?? null;

/** Rows whose field work is recorded but not yet concluded by the Testing module. */
export const untestedRows = (e: Engagement) => e.rcm.filter((r) => e.testInputs[r.id] && !e.testResults[r.id]).map((r) => r.id);

/** What a redraft of this subject is built from. The graph never repeats a redraft from the same basis. */
export function redraftBasis(e: Engagement, subjectKey: string, rows?: string[]): string {
  const s = subjectInfo(e, subjectKey);
  if (s) return s.basis;
  if (subjectKey === 'testing') return sha256(canonicalJson(untestedRows(e).map((id) => [id, e.testInputs[id]])));
  return sha256(canonicalJson({ subjectKey, rows: (rows ?? []).map((id) => [id, rowBasis(e, id)]) }));
}

function delegate(input: GraphInput, specialist: Specialist, subjectKey: string, rows?: string[]): Action {
  const basis = redraftBasis(input.engagement, subjectKey, rows);
  const since = latestGateId(input.gates, subjectKey);
  const repeated = input.redrafts.some((r) => r.kind === 'delegate' && r.subjectKey === subjectKey && r.basis === basis && r.sinceGateId === since);
  if (repeated) return { type: 'escalate', reason: `The ${specialist} specialist already ran for ${subjectKey} and it is still not ready; check it by hand, then resume` };
  return { type: 'delegate', specialist, subjectKey, ...(rows ? { rows } : {}) };
}

interface StepOptions {
  specialist: Specialist;
  rows?: string[];
  /** False while the subject may not be redrafted (a reviewed finding). */
  canRework: boolean;
  blockedReason?: string;
}

function rework(o: StepOptions, subjectKey: string, instruction: string): Action {
  if (!o.canRework) return { type: 'wait', reason: o.blockedReason ?? `${subjectKey} cannot be redrafted now` };
  return { type: 'rework', specialist: o.specialist, subjectKey, instruction: instruction.slice(0, 2000), ...(o.rows ? { rows: o.rows } : {}) };
}

/** A fresh draft from the current basis, unless the subject may not be redrafted now (a reviewed finding). */
function rebuild(input: GraphInput, o: StepOptions, key: string): Action {
  if (!o.canRework) return { type: 'wait', reason: o.blockedReason ?? `${key} cannot be redrafted now` };
  return delegate(input, o.specialist, key, o.rows);
}

const summarise = (r: QaReport) => r.issues.map((i) => `${i.criterion}: ${i.detail}`).join('; ');

/** One subject: produce it, review it, gate it, and react to the gate. `passed` once its gate is approved and current. */
function subjectStep(input: GraphInput, key: string, o: StepOptions): Step {
  const s = subjectInfo(input.engagement, key);
  if (!s || !s.present) return act([delegate(input, o.specialist, key, o.rows)]);
  const g = latestGate(input.gates, key);
  const mine = input.redrafts.filter((r) => r.subjectKey === key && r.sinceGateId === (g?.id ?? null));
  const label = s.gateKind ?? 'test plans';

  if (g?.state === 'approved') {
    if (g.subjectHash === s.hash && g.basisHash === s.basis) return { passed: true };
    // What it was built from changed: rebuild it once, then review the rebuilt version. (Edited by hand: review it.)
    if (g.basisHash !== s.basis && !mine.some((r) => r.basis === s.basis)) return act([rebuild(input, o, key)]);
  }
  // Built on a basis that is no longer current, before any gate approved it (its upstream changed meanwhile): rebuild it once.
  const lastBuilt = findLast(input.redrafts, (r) => r.subjectKey === key);
  if (lastBuilt && lastBuilt.basis !== s.basis && !input.redrafts.some((r) => r.subjectKey === key && r.basis === s.basis)) {
    return act([rebuild(input, o, key)]);
  }
  if (g?.state === 'open') {
    return act([{ type: 'wait', reason: `awaiting ${s.gateKind} gate signature${s.gateKind === 'finding' ? ` (${s.subjectId})` : ''}` }]);
  }
  if (g?.state === 'rejected' && g.subjectHash === s.hash) {
    const rejections = input.gates.filter((x) => x.subjectKey === key && x.state === 'rejected').length;
    if (rejections >= MAX_REJECTIONS) return act([{ type: 'escalate', reason: `gate_rejected_twice: ${key}` }]);
    if (mine.some((r) => r.kind === 'rework')) return act([{ type: 'escalate', reason: `rework produced no change: ${key}; edit it by hand, then resume` }]);
    return act([rework(o, key, g.comment.trim() || `Address the reasons the ${label} gate was rejected`)]);
  }

  // No gate yet, the last one was superseded, or a person edited it after a rejection or approval: QA, then a gate.
  const report = findLast(input.qa, (q) => q.subjectKey === key && q.subjectHash === s.hash) ?? null;
  if (!report) return act([{ type: 'request_qa', subjectKey: key, mode: 'review' }]);
  const blocking = report.issues.some((i) => i.severity === 'blocking');
  if (!s.gateKind) return blocking ? act([{ type: 'escalate', reason: `QA found blocking issues in the ${label}` }], report) : { passed: true };
  const lowScore = report.score < input.qaThreshold;
  if (!report.issues.length && !lowScore) return act([{ type: 'open_gate', subjectKey: key }], report);
  const actions: Action[] = [];
  if (!blocking) actions.push({ type: 'open_gate', subjectKey: key });
  if (o.canRework && mine.filter((r) => r.kind === 'rework').length < MAX_SELF_REWORKS) {
    actions.push(rework(o, key, report.issues.length ? summarise(report) : `QA scored ${report.score}, below ${input.qaThreshold}`));
  }
  actions.push({
    type: 'escalate',
    reason: report.issues.length
      ? `QA found ${report.issues.length} issue(s) in the ${label}${blocking ? ', some blocking' : ''}`
      : `QA scored ${report.score} for the ${label}, below ${input.qaThreshold}`,
  });
  return act(actions, report);
}

/** The actions the supervisor may take next. Every reachable state offers at least one. */
export function allowedActions(input: GraphInput): Menu {
  const e = input.engagement;
  const menu = (stage: Stage, step: Exclude<Step, { passed: true }>): Menu => ({ stage, actions: step.actions, qa: step.qa, qaThreshold: input.qaThreshold });
  const only = (stage: Stage, action: Action): Menu => ({ stage, actions: [action], qa: null, qaThreshold: input.qaThreshold });

  const workpapers: [Stage, string, Specialist][] = [['scope', 'scope', 'scope'], ['rcm', 'rcm', 'rcm'], ['test_plans', 'test_plans', 'test-plan']];
  for (const [stage, key, specialist] of workpapers) {
    const step = subjectStep(input, key, { specialist, canRework: true });
    if (!step.passed) return menu(stage, step);
  }

  // Field work is done by people: wait until every row has a recorded test, or a person's reason for not testing it.
  const awaiting = e.rcm.filter((r) => !e.testInputs[r.id] && !e.testPlans[r.id]?.notTestedJustification?.trim());
  if (awaiting.length) return only('awaiting_tests', { type: 'wait', reason: `awaiting test results for ${awaiting.length} control(s)` });
  if (untestedRows(e).length) return only('testing', delegate(input, 'testing', 'testing'));

  // A failed row needs a finding; a finding on a row that no longer fails must go, unless it is approved (locked).
  const failed = new Set(e.rcm.filter((r) => FAILED.has(e.testResults[r.id]?.conclusion ?? '')).map((r) => r.id));
  const byRow = new Map(e.findings.map((f) => [f.rowId, f]));
  const stale = e.rcm
    .map((r) => r.id)
    .filter((id) => (failed.has(id) && !byRow.has(id)) || (!failed.has(id) && byRow.has(id) && byRow.get(id)!.status !== 'approved'));
  const redraftable = stale.filter((id) => byRow.get(id)?.status !== 'reviewed');
  if (redraftable.length) return only('gaps', delegate(input, 'gaps', 'gaps', redraftable));
  if (stale.length) return only('gaps', { type: 'wait', reason: 'awaiting signatures on reviewed findings before they can be redrafted' });

  const waits: string[] = [];
  for (const r of e.rcm) {
    const f = byRow.get(r.id);
    if (f?.status === 'approved') {
      // Approved findings are locked: the agent cannot redraft one whose test results changed after its gate.
      const g = latestGate(input.gates, findingKey(r.id));
      if (g && g.basisHash !== rowBasis(e, r.id)) {
        return only('findings', { type: 'escalate', reason: `finding ${f.id} was approved on test results that have since changed; a person must decide what to do with it` });
      }
      continue;
    }
    if (!f) continue;
    const step = subjectStep(input, findingKey(r.id), {
      specialist: 'gaps', rows: [r.id], canRework: f.status !== 'reviewed',
      blockedReason: `finding ${f.id} is reviewed; it can only be approved or rejected now`,
    });
    if (step.passed) continue;
    if (step.actions.every((a) => a.type === 'wait')) {
      waits.push(...step.actions.flatMap((a) => (a.type === 'wait' ? [a.reason] : [])));
      continue;
    }
    return menu('findings', step);
  }
  if (waits.length) return only('findings', { type: 'wait', reason: waits.join('; ') });

  const report = subjectStep(input, 'report', { specialist: 'report', canRework: true });
  if (!report.passed) return menu('report', report);
  return only('done', { type: 'complete' });
}
