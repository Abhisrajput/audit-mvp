import { canonicalJson } from '../engine/trail';
import type { Engagement, Finding, ScopeItem, TestPlan } from '../engine/types';
import { AppError } from '../errors';

// What an agent may never do, however it was asked (spec §5.4). These checks run inside the transaction of every
// agent write, before it commits, whatever the graph or a model decided.

const forbidden = (message: string) => new AppError(403, message, 'AGENT_FORBIDDEN');

/** A redrafted scope keeps every in/out decision already made for a control it still proposes. */
export function keepScopeDecisions(previous: ScopeItem[], next: ScopeItem[]): void {
  const decided = new Map(previous.map((s) => [s.controlId, s.included]));
  for (const s of next) if (decided.has(s.controlId)) s.included = decided.get(s.controlId)!;
}

/** The findings after redrafting only `rows`: every other finding stays exactly as it was. */
export function mergeFindings(previous: Finding[], drafted: Finding[], rows: string[], rowOrder: string[]): Finding[] {
  const target = new Set(rows);
  const order = new Map(rowOrder.map((id, i) => [id, i]));
  const kept = previous.filter((f) => !target.has(f.rowId));
  const fresh = drafted.filter((f) => target.has(f.rowId) && !previous.some((p) => p.id === f.id));
  const at = (f: Finding) => order.get(f.rowId) ?? rowOrder.length;
  return [...kept, ...fresh].sort((x, y) => at(x) - at(y));
}

/** Only an auditor decides a row will not be tested. Plans for rows that left the RCM may go. */
export function assertJustificationsUnchanged(before: Record<string, TestPlan>, after: Record<string, TestPlan>, rowIds: string[]): void {
  const live = new Set(rowIds);
  const ids = new Set([...Object.keys(after), ...Object.keys(before).filter((id) => live.has(id))]);
  for (const id of ids) {
    if ((before[id]?.notTestedJustification ?? '') !== (after[id]?.notTestedJustification ?? '')) throw forbidden(`Only an auditor may decide not to test ${id}`);
  }
}

/** An agent's plans may not carry a person's name, and may not overwrite a plan a person edited unless its row changed. */
export function assertPlanAttribution(before: Record<string, TestPlan>, after: Record<string, TestPlan>): void {
  for (const [id, plan] of Object.entries(after)) {
    const old = before[id];
    if ((plan.editedBy !== undefined && plan.editedBy !== old?.editedBy) || (plan.editedAt !== undefined && plan.editedAt !== old?.editedAt)) {
      throw forbidden(`An agent may not attribute work to a person (test plan ${id})`);
    }
    if (old?.editedBy && old.rowHash === plan.rowHash && canonicalJson(old) !== canonicalJson(plan)) {
      throw forbidden(`An agent may not change a test plan a person edited (${id})`);
    }
  }
}

/** The engagement after an agent's change, checked against the engagement before it. */
export function assertWithinRails(before: Engagement, after: Engagement): void {
  if (canonicalJson(before.testInputs) !== canonicalJson(after.testInputs)) throw forbidden('An agent may not record or change test results');
  const now = new Map(after.findings.map((f) => [f.id, f]));
  for (const f of before.findings) {
    if (f.status !== 'reviewed' && f.status !== 'approved') continue;
    const g = now.get(f.id);
    if (!g || canonicalJson(g) !== canonicalJson(f)) throw forbidden(`An agent may not change finding ${f.id} after it has been reviewed`);
  }
  const signed = new Map(before.findings.map((f) => [f.id, f.signOffs.length]));
  for (const f of after.findings) if (f.signOffs.length > (signed.get(f.id) ?? 0)) throw forbidden('An agent may not sign');
  assertJustificationsUnchanged(before.testPlans, after.testPlans, after.rcm.map((r) => r.id));
}
