import type { ContextFactor, FactorKind, Gate, RiskRating, ScopeItem } from './types';

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
