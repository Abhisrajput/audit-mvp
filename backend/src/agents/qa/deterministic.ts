import type { Engagement } from '../../engine/types';
import { rowOfKey, subjectInfo } from '../subjects';
import type { QaIssue, QaReport } from '../types';

// The offline QA review (spec §5.5): the checks that need no model. Blocking issues stop a gate from opening;
// advisory ones travel with the gate to the signer.

export const DETERMINISTIC_REVIEWER = 'deterministic-1';

const blocking = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'blocking', detail });
const advisory = (criterion: string, detail: string): QaIssue => ({ criterion, severity: 'advisory', detail });

function scopeIssues(e: Engagement): QaIssue[] {
  const included = e.scope.filter((s) => s.included);
  return [
    ...(included.length ? [] : [blocking('scope.included', 'No control is in scope')]),
    ...included.filter((s) => !s.citations.length).map((s) => advisory('scope.citations', `${s.controlId} is in scope without a regulatory citation`)),
    ...e.scope.filter((s) => !s.included && s.inherentRisk === 'High').map((s) => advisory('scope.high-risk-excluded', `High inherent-risk control ${s.controlId} is out of scope`)),
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

/** Reviews one subject as it stands now. The report is tied to the content hash it reviewed. */
export function reviewSubject(e: Engagement, subjectKey: string): QaReport {
  const s = subjectInfo(e, subjectKey);
  if (!s) throw new Error(`Nothing to review for ${subjectKey}`);
  const rowId = rowOfKey(subjectKey);
  const issues =
    subjectKey === 'scope' ? scopeIssues(e)
    : subjectKey === 'rcm' ? rcmIssues(e)
    : subjectKey === 'test_plans' ? planIssues(e)
    : subjectKey === 'report' ? reportIssues(e)
    : findingIssues(e, rowId!);
  const b = issues.filter((i) => i.severity === 'blocking').length;
  const a = issues.length - b;
  return { subjectKey, subjectHash: s.hash, mode: 'review', reviewer: DETERMINISTIC_REVIEWER, score: Math.max(0, 100 - 25 * b - 10 * Math.min(a, 3)), issues };
}
