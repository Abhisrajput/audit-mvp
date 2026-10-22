import type { Executor } from '../db/trail-repo';
import type { Engagement } from '../engine/types';
import { listGates, supersedeGate, type Gate } from './gate-repo';
import { listSteps, type AgentRun } from './run-repo';
import { findingKey, subjectInfo } from './subjects';
import type { Action, GraphInput, QaReport, RedraftRecord } from './types';

/** What a delegate step records, so later iterations know what was redrafted, from what, and since which gate. */
export interface DelegateRecord {
  action: Extract<Action, { type: 'delegate' | 'rework' }>;
  basis: string;
  sinceGateId: string | null;
  /** Absent when the specialist saved nothing (the evidence specialist found no draft to keep). */
  bundleId?: string;
  /** For a Gap Writer run: the basis each targeted row's finding was drafted from. */
  rowBases?: Record<string, string>;
  /** A model was configured but failed, so the specialist drafted on its offline rules (spec §6.3). QA tells the signer. */
  withoutModel?: true;
  /** Rows the evidence specialist refused to draft, with why. */
  noDraft?: { rowId: string; reason: string }[];
}

/** Supersedes each open gate whose subject changed, vanished or was rebuilt on a new basis since it opened. Returns how many. */
export async function reconcileGates(db: Executor, e: Engagement): Promise<number> {
  let superseded = 0;
  for (const g of await listGates(db, e.id)) {
    if (g.state !== 'open') continue;
    const s = subjectInfo(e, g.subjectKey);
    if (s && s.subjectId === g.subjectId && s.hash === g.subjectHash && s.basis === g.basisHash) continue;
    await supersedeGate(db, g.id);
    superseded++;
  }
  return superseded;
}

/** The graph's input for one iteration: the engagement, its gates, and this run's QA reports and redrafts. */
export async function loadGraphInput(db: Executor, run: AgentRun, e: Engagement, gates: Gate[], qaThreshold: number): Promise<GraphInput> {
  const steps = await listSteps(db, run.id);
  const qa = steps.filter((s) => s.kind === 'qa').map((s) => s.decision as QaReport);
  const redrafts: RedraftRecord[] = steps
    .filter((s) => s.kind === 'delegate')
    .flatMap((s) => {
      const d = s.decision as DelegateRecord;
      const own: RedraftRecord = { subjectKey: d.action.subjectKey, kind: d.action.type, basis: d.basis, sinceGateId: d.sinceGateId };
      // A Gap Writer run drafted each targeted row's finding from that row's basis.
      const findings = Object.entries(d.rowBases ?? {}).map(([rowId, basis]): RedraftRecord => ({ subjectKey: findingKey(rowId), kind: d.action.type, basis, sinceGateId: null }));
      return [own, ...findings];
    });
  return { engagement: e, gates, qa, redrafts, qaThreshold };
}
