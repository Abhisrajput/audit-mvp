import type { Engagement, QaAction } from '../../engine/types';
import type { PackRegistry } from '../../engine/packs';
import { rcmCitationGate } from '../../engine/qa';
import { trustActions, type CitationPolicy } from '../../engine/trust';
import { areaRisk, isTouched, RANK } from '../../judgment/risk-assessment';
import { statementCoversAll } from '../../judgment/coverage';
import { rowOfKey, subjectInfo } from '../subjects';
import type { QaIssue, QaReport } from '../types';

// The offline QA review (spec §5.5): the checks that need no model. Blocking issues stop a gate from opening;
// advisory ones travel with the gate to the signer.

export const DETERMINISTIC_REVIEWER = 'deterministic-1';

/** The automatic review with the citation gate and trust rules added (what the worker always runs). */
export const CHECKED_REVIEWER = 'deterministic-2';

/** What the citation and trust checks need (engine/qa.ts, REQ-22). */
export interface QaChecks {
  registry: PackRegistry;
  policy: CitationPolicy;
  today?: string;
}

const blocking = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'blocking', detail });
const advisory = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'advisory', detail });

/** The distinct process areas, in order of first appearance. */
const areasOf = (names: string[]): string[] => [...new Set(names)];

/**
 * Scope checks. The risk and coverage checks (spec §5.1, §5.2) only have something to say once the engagement has a
 * context or a coverage, so a scope without them raises nothing new. The unknown-area check runs only when the
 * caller knows the library's areas.
 */
function scopeIssues(e: Engagement, knownAreas?: Set<string>): QaIssue[] {
  const included = e.scope.filter((s) => s.included);
  const touchedHighExcluded = areasOf(e.scope.map((s) => s.processArea)).filter((area) => {
    const items = e.scope.filter((s) => s.processArea === area);
    return isTouched(e.context, area) && areaRisk(items) === 'High' && !items.some((s) => s.included);
  });
  const factorAreas = areasOf((e.context?.factors ?? []).flatMap((f) => f.processAreas));
  return [
    ...(included.length ? [] : [blocking('scope.included', 'No control is in scope')]),
    ...included.filter((s) => !s.citations.length).map((s) => advisory('scope.citations', `${s.controlId} is in scope without a regulatory citation`)),
    ...e.scope.filter((s) => !s.included && s.inherentRisk === 'High').map((s) => advisory('scope.high-risk-excluded', `High inherent-risk control ${s.controlId} is out of scope`)),
    // The assessment may raise a library rating, never lower it.
    ...e.scope.filter((s) => RANK[s.assessedRisk] < RANK[s.inherentRisk]).map((s) => blocking('scope.assessed-below-library', `${s.controlId} is assessed ${s.assessedRisk}, below its library rating ${s.inherentRisk}`)),
    // An area the context speaks of, rated High, with nothing of it in scope.
    ...touchedHighExcluded.map((area) => blocking('scope.touched-high-excluded', `${area} is named by the engagement context and rated High, but none of its controls is in scope`)),
    ...(knownAreas ? factorAreas.filter((a) => !knownAreas.has(a)).map((a) => advisory('scope.factor-unknown-area', `A context factor names ${a}, which is not a process area of the selected packs`)) : []),
    ...(e.coverage && !statementCoversAll(e.coverage.statement, e.coverage.excluded) ? [advisory('scope.coverage-statement', 'The coverage statement does not name every excluded process area')] : []),
  ];
}

function rcmIssues(e: Engagement): QaIssue[] {
  return [
    ...(e.rcm.length ? [] : [blocking('rcm.rows', 'The RCM has no rows')]),
    ...e.rcm.filter((r) => !r.citations.length).map((r) => blocking('rcm.citations', `${r.id} cites no regulatory clause`)),
    ...e.rcm.filter((r) => r.sampleSize < 1).map((r) => advisory('rcm.sample', `${r.id} has no sample size`)),
    ...e.rcm.filter((r) => !r.testOfEffectiveness.length).map((r) => advisory('rcm.procedure', `${r.id} has no test of operating effectiveness`)),
  ];
}

function planIssues(e: Engagement): QaIssue[] {
  return e.rcm.flatMap((r) => {
    const p = e.testPlans[r.id];
    if (!p) return [blocking('plans.coverage', `${r.id} has no test plan`)];
    return [
      ...(p.evidenceToRequest.length ? [] : [advisory('plans.evidence', `${r.id}: the plan requests no evidence`)]),
      ...(p.selectionMethod !== 'all' && p.sampleSize < r.sampleSize ? [advisory('plans.sample', `${r.id}: a sample of ${p.sampleSize} is below the RCM's ${r.sampleSize}`)] : []),
    ];
  });
}

function findingIssues(e: Engagement, rowId: string): QaIssue[] {
  const f = e.findings.find((x) => x.rowId === rowId)!;
  const empty = (['condition', 'criteria', 'cause', 'effect', 'recommendation'] as const).filter((k) => !f[k].trim());
  return [
    ...(f.status === 'blocked' ? [blocking('finding.blocked', f.blockedReasons.join('; ') || 'Blocked by the QA gates')] : []),
    ...empty.map((k) => blocking('finding.five-cs', `${f.id} has no ${k}`)),
    ...(f.citations.length ? [] : [blocking('finding.citations', `${f.id} cites no regulatory clause`)]),
    ...(f.evidenceRefs.length ? [] : [blocking('finding.evidence', `${f.id} cites no evidence`)]),
  ];
}

function reportIssues(e: Engagement): QaIssue[] {
  const report = e.report;
  if (!report) return [blocking('report.missing', 'No report has been generated')];
  const missing = e.findings.filter((f) => f.status === 'approved' && !report.includedFindingIds.includes(f.id));
  return [
    ...missing.map((f) => blocking('report.coverage', `Approved finding ${f.id} is not in the report`)),
    ...(report.excludedFindingIds.length ? [advisory('report.excluded', `${report.excludedFindingIds.length} finding(s) are listed as excluded`)] : []),
  ];
}

/** Trust-rule actions as issues. Where `canBlock` is false (scope proposals), even a blocked source is only advisory. */
function trustIssues(prefix: string, actions: QaAction[], canBlock: boolean): QaIssue[] {
  return actions.filter((a) => a.outcome !== 'pass').map((a) => (a.outcome === 'fail' && canBlock ? blocking : advisory)(`${prefix}.trust`, `${a.target}: ${a.detail}`));
}

/** The engine's citation gate and the trust rules, run again on the subject as it stands (spec §5.5 "always"). */
function checkedIssues(e: Engagement, subjectKey: string, c: QaChecks): QaIssue[] {
  const cites = (citations: { clauseId: string }[]) => citations.map((x) => x.clauseId);
  if (subjectKey === 'scope') {
    return e.scope.filter((s) => s.included).flatMap((s) => trustIssues('scope', trustActions(c.registry, s.controlId, { clauseIds: cites(s.citations), controlId: s.controlId }, c.policy, c.today), false));
  }
  if (subjectKey === 'rcm') {
    return e.rcm.flatMap((r) => {
      const gate = rcmCitationGate(c.registry, r);
      return [
        // A row with no citation at all is already blocked by rcm.citations.
        ...(r.citations.length && gate.outcome === 'fail' ? [blocking('rcm.citation-gate', `${r.id}: ${gate.detail}`)] : []),
        ...trustIssues('rcm', trustActions(c.registry, r.id, { clauseIds: cites(r.citations), controlId: r.controlId }, c.policy, c.today), true),
      ];
    });
  }
  const rowId = rowOfKey(subjectKey);
  const f = rowId ? e.findings.find((x) => x.rowId === rowId) : undefined;
  if (!f) return [];
  const unknown = f.citations.filter((x) => !c.registry.clauses.has(x.clauseId)).map((x) => x.clauseId);
  return [
    ...(unknown.length ? [blocking('finding.citation-unknown', `${f.id} cites clauses not in the corpus: ${unknown.join(', ')}`)] : []),
    ...trustIssues('finding', trustActions(c.registry, f.id, { clauseIds: cites(f.citations), controlId: f.controlId }, c.policy, c.today), true),
  ];
}

/**
 * Reviews one subject as it stands now. The report is tied to the content hash it reviewed. With `checks`, the citation
 * gate and the trust rules run as well (the worker always passes them; pure tests may not).
 */
export function reviewSubject(e: Engagement, subjectKey: string, checks?: QaChecks, knownAreas?: Set<string>): QaReport {
  const s = subjectInfo(e, subjectKey);
  if (!s) throw new Error(`Nothing to review for ${subjectKey}`);
  const rowId = rowOfKey(subjectKey);
  // With the checks, the library's areas come from the controls of the engagement's packs.
  const areas = knownAreas ?? (checks ? new Set(checks.registry.controlsFor(e.packIds).map((c) => c.processArea)) : undefined);
  const own =
    subjectKey === 'scope' ? scopeIssues(e, areas)
    : subjectKey === 'rcm' ? rcmIssues(e)
    : subjectKey === 'test_plans' ? planIssues(e)
    : subjectKey === 'report' ? reportIssues(e)
    : findingIssues(e, rowId!);
  const issues = [...own, ...(checks ? checkedIssues(e, subjectKey, checks) : [])];
  const b = issues.filter((i) => i.severity === 'blocking').length;
  const a = issues.length - b;
  return {
    subjectKey, subjectHash: s.hash, mode: 'review', reviewer: checks ? CHECKED_REVIEWER : DETERMINISTIC_REVIEWER,
    score: Math.max(0, 100 - 25 * b - 10 * Math.min(a, 3)), issues,
  };
}
