import type { ContextFactor, Engagement, FactorKind, Gate, Impact, JudgmentMemo, Likelihood, Opinion, RiskRating, ScopeItem, Severity } from './types';

export const FACTOR_LABELS: Record<FactorKind, string> = {
  change: 'Process or system change',
  incident: 'Incident, deviation or complaint',
  regulatory: 'Regulatory action or inspection',
  prior_finding: 'Prior audit finding',
  complexity: 'Complexity or volume',
};

// The server's limits (backend judgment/context.ts), repeated here so problems show before a save.
const LIMITS = { factors: 50, description: 500, background: 4000, areas: 50, areaName: 100 };
const RANK: Record<RiskRating, number> = { Low: 0, Medium: 1, High: 2 };

/** Distinct process areas of the engagement's scope candidates (after a scope run) or of the chosen packs' controls (before), sorted. */
export function areaOptions(scope: ScopeItem[], packControls: { processArea: string; packId: string }[], packIds: string[]): string[] {
  const areas = scope.length ? scope.map((s) => s.processArea) : packControls.filter((c) => packIds.includes(c.packId)).map((c) => c.processArea);
  return [...new Set(areas)].sort();
}

/** Client-side problems before a save, mirroring the server's limits; [] when fine. */
export function contextProblems(input: { factors: ContextFactor[]; background: string }): string[] {
  const problems: string[] = [];
  if (input.factors.length > LIMITS.factors) problems.push(`At most ${LIMITS.factors} factors`);
  input.factors.forEach((f, i) => {
    if (!f.description.trim()) problems.push(`Factor ${i + 1} needs a description`);
    else if (f.description.length > LIMITS.description) problems.push(`Factor ${i + 1} is over ${LIMITS.description} characters`);
    if (f.processAreas.length > LIMITS.areas) problems.push(`Factor ${i + 1} names more than ${LIMITS.areas} areas`);
    if (f.processAreas.some((a) => a.trim().length > LIMITS.areaName)) problems.push(`Factor ${i + 1} names an area over ${LIMITS.areaName} characters`);
  });
  if (input.background.length > LIMITS.background) problems.push(`Background is over ${LIMITS.background} characters`);
  return problems;
}

/** True once the engagement has an approved RCM gate. */
export function contextLocked(gates: Gate[]): boolean {
  return gates.some((g) => g.kind === 'rcm' && g.state === 'approved');
}

/** A scope item's assessed risk; rows stored before migration 012 have none, and their library rating stands. */
export const assessedRiskOf = (s: ScopeItem): RiskRating => s.assessedRisk ?? s.inherentRisk;

/** A scope item's risk factors; rows stored before migration 012 have none. */
export const riskFactorsOf = (s: ScopeItem): string[] => s.riskFactors ?? [];

/** Areas raised by the context, with library and assessed ratings, for the risk table. */
export function raisedAreas(scope: ScopeItem[]): { processArea: string; library: RiskRating; assessed: RiskRating; factors: string[] }[] {
  const byArea = new Map<string, { library: RiskRating; assessed: RiskRating; factors: string[] }>();
  for (const s of scope.filter((i) => RANK[assessedRiskOf(i)] > RANK[i.inherentRisk])) {
    const assessed = assessedRiskOf(s);
    const row = byArea.get(s.processArea) ?? { library: s.inherentRisk, assessed, factors: [] };
    if (RANK[s.inherentRisk] > RANK[row.library]) row.library = s.inherentRisk;
    if (RANK[assessed] > RANK[row.assessed]) row.assessed = assessed;
    row.factors.push(...riskFactorsOf(s).filter((f) => !row.factors.includes(f)));
    byArea.set(s.processArea, row);
  }
  return [...byArea].map(([processArea, r]) => ({ processArea, ...r })).sort((a, b) => a.processArea.localeCompare(b.processArea));
}

export const SEVERITIES: Severity[] = ['none', 'isolated', 'systemic', 'pervasive'];
export const LIKELIHOODS: Likelihood[] = ['rare', 'possible', 'likely'];
export const IMPACTS: Impact[] = ['minor', 'moderate', 'major'];

export const SEVERITY_LABELS: Record<Severity, string> = { none: 'No exceptions', isolated: 'Isolated', systemic: 'Systemic', pervasive: 'Pervasive' };
export const LIKELIHOOD_LABELS: Record<Likelihood, string> = { rare: 'Rare', possible: 'Possible', likely: 'Likely' };
export const IMPACT_LABELS: Record<Impact, string> = { minor: 'Minor', moderate: 'Moderate', major: 'Major' };

// The server's rating matrix (backend judgment/finding.ts), repeated so the dialog shows the rating as the person chooses.
const MATRIX: Record<Impact, Record<Likelihood, RiskRating>> = {
  major: { rare: 'Medium', possible: 'High', likely: 'High' },
  moderate: { rare: 'Medium', possible: 'Medium', likely: 'High' },
  minor: { rare: 'Low', possible: 'Low', likely: 'Low' },
};
const TOLERANCE_MAX = 0.25;

export function ratingOf(likelihood: Likelihood, impact: Impact): RiskRating {
  return MATRIX[impact][likelihood];
}

/** The impact a stored rating implies, for findings saved before likelihood and impact existed. */
export const impactOfRating = (r: RiskRating): Impact => (r === 'High' ? 'major' : r === 'Medium' ? 'moderate' : 'minor');

/** A memo by subject key; a finding's memo lives on the finding, under `finding:<rowId>`. */
export function memoFor(e: Pick<Engagement, 'memos' | 'findings'>, subjectKey: string): JudgmentMemo | undefined {
  if (Object.hasOwn(e.memos ?? {}, subjectKey)) return e.memos[subjectKey];
  if (!subjectKey.startsWith('finding:')) return undefined;
  const rowId = subjectKey.slice('finding:'.length);
  return e.findings.find((f) => f.rowId === rowId)?.memo;
}

/** A tolerance can be set until a test has been recorded for the row. */
export function toleranceEditable(e: Pick<Engagement, 'testInputs'>, rowId: string): boolean {
  return !Object.hasOwn(e.testInputs ?? {}, rowId);
}

/** True once the report gate is approved; management responses are then closed. */
export function responsesLocked(gates: Gate[]): boolean {
  return gates.some((g) => g.kind === 'report' && g.state === 'approved');
}

/** A percent typed by a person as a rate, rounded to a tenth of a percent (12.3 gives 0.123). */
export const percentToRate = (text: string): number => Math.round(Number(text) * 10) / 1000;

/** Problems with a tolerance rate (0 to 25%); [] when fine. */
export function toleranceProblems(rate: number): string[] {
  if (!Number.isFinite(rate)) return ['Enter a tolerance as a percentage'];
  if (rate < 0) return ['Tolerance cannot be negative'];
  if (rate > TOLERANCE_MAX) return [`Tolerance cannot be above ${TOLERANCE_MAX * 100}%`];
  return [];
}

export const OPINION_LABELS: Record<Opinion, string> = { satisfactory: 'Satisfactory', needs_improvement: 'Needs improvement', unsatisfactory: 'Unsatisfactory' };

export function opinionColor(o: Opinion): 'success' | 'warning' | 'error' {
  return o === 'satisfactory' ? 'success' : o === 'needs_improvement' ? 'warning' : 'error';
}

/** Approved findings and how many of them have a management response (an engagement from before responses has none). */
export function responsesRecorded(e: Pick<Engagement, 'findings' | 'responses'>): { recorded: number; approved: number } {
  const approved = e.findings.filter((f) => f.status === 'approved');
  return { recorded: approved.filter((f) => e.responses?.[f.id]).length, approved: approved.length };
}
