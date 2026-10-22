import { canonicalJson, sha256 } from '../engine/trail';
import type { Engagement, JudgmentMemo, RcmRow } from '../engine/types';
import { contextBasis } from '../judgment/context';
import { findingContentHash, workpaperContentHash } from '../signing/content-hash';
import type { GateKind } from './types';

// What the supervisor works on. Each subject has a key, a content hash and a basis: the hash of what it was built from.
// A gate records both when it opens, so the graph can tell an approved subject that is still current from one that
// was edited (hash) or whose upstream changed (basis).

const FINDING_PREFIX = 'finding:';
export const findingKey = (rowId: string) => `${FINDING_PREFIX}${rowId}`;
export const rowOfKey = (key: string): string | null => (key.startsWith(FINDING_PREFIX) ? key.slice(FINDING_PREFIX.length) : null);

/** The scope is built from the scope statement and the packs. */
export const rootBasis = (e: Engagement) => sha256(canonicalJson({ scopeStatement: e.scopeStatement, packIds: e.packIds, ...(contextBasis(e.context) ? { context: contextBasis(e.context) } : {}) }));

/** A finding is built from its row's recorded test and conclusion. */
export const rowBasis = (e: Engagement, rowId: string) => sha256(canonicalJson({ input: e.testInputs[rowId] ?? null, result: e.testResults[rowId] ?? null }));

/** The report is built from the approved findings. */
export function approvedFindingsBasis(e: Engagement): string {
  const approved = e.findings
    .filter((f) => f.status === 'approved')
    .map((f) => ({ id: f.id, hash: findingContentHash(f) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (Object.keys(e.responses ?? {}).length === 0) return sha256(canonicalJson(approved));
  const responses = Object.values(e.responses)
    .map((r) => ({ findingId: r.findingId, id: r.id }))
    .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
  return sha256(canonicalJson({ findings: approved, responses }));
}

export const rcmRowHash = (row: RcmRow) => sha256(canonicalJson(row));

/** Every RCM row has a plan drafted from its current version, and there are no plans for rows that are gone. */
export function plansCurrent(e: Engagement): boolean {
  const ids = new Set(e.rcm.map((r) => r.id));
  if (Object.keys(e.testPlans).some((id) => !ids.has(id))) return false;
  return e.rcm.every((r) => e.testPlans[r.id]?.rowHash === rcmRowHash(r));
}

export interface SubjectInfo {
  key: string;
  /** null for test plans, which have no gate. */
  gateKind: GateKind | null;
  subjectId: string;
  hash: string;
  basis: string;
  /** False when the specialist has not produced it (or, for test plans, they are out of date). */
  present: boolean;
}

/** The subject behind a key, or null when there is none (an unknown key, or a row without a finding). */
export function subjectInfo(e: Engagement, key: string): SubjectInfo | null {
  switch (key) {
    case 'scope':
      return { key, gateKind: 'scope', subjectId: 'scope', hash: workpaperContentHash('scope', e), basis: rootBasis(e), present: e.scope.length > 0 };
    case 'rcm':
      return { key, gateKind: 'rcm', subjectId: 'rcm', hash: workpaperContentHash('rcm', e), basis: workpaperContentHash('scope', e), present: e.rcm.length > 0 };
    case 'test_plans':
      return { key, gateKind: null, subjectId: 'test_plans', hash: workpaperContentHash('test_plans', e), basis: workpaperContentHash('rcm', e), present: plansCurrent(e) };
    case 'report':
      return { key, gateKind: 'report', subjectId: 'report', hash: workpaperContentHash('report', e), basis: approvedFindingsBasis(e), present: e.report !== null };
  }
  const rowId = rowOfKey(key);
  const f = rowId ? e.findings.find((x) => x.rowId === rowId) : undefined;
  if (!rowId || !f) return null;
  return { key, gateKind: 'finding', subjectId: f.id, hash: findingContentHash(f), basis: rowBasis(e, rowId), present: true };
}

/** The judgment memo behind a subject: its own entry, else (for a finding) the memo on the finding. */
export function menuMemo(e: Engagement, subjectKey: string | undefined): JudgmentMemo | null {
  if (!subjectKey) return null;
  if (Object.hasOwn(e.memos ?? {}, subjectKey)) return e.memos[subjectKey];
  const rowId = rowOfKey(subjectKey);
  return (rowId && e.findings.find((f) => f.rowId === rowId)?.memo) || null;
}
