// Sampling rules (spec §5.3): how many items to test, how they are chosen, and the
// tolerance a person may accept. Pure: no I/O, no database, no model calls.

import type { EngagementContext, Frequency, RcmRow, RiskRating, TestPlan } from '../engine/types';
import { factorsFor } from './context';

// Sample sizes by control frequency, [lower risk, high risk]. A common
// internal-audit convention; calibrate to the client's methodology.
export const SAMPLE_TABLE: Record<Frequency, [number, number]> = {
  Annual: [1, 1],
  Quarterly: [2, 2],
  Monthly: [2, 3],
  Weekly: [5, 10],
  Daily: [20, 30],
  'Per event': [25, 40],
  'Per batch': [10, 20],
};

/** The table cell for a frequency and the assessed risk: high risk takes the second column. */
export function sampleSize(frequency: Frequency, risk: RiskRating): number {
  const [low, high] = SAMPLE_TABLE[frequency];
  return risk === 'High' ? high : low;
}

/** §5.3: the tolerance rate the agent recommends a person consider, by assessed risk; zero for pharma and food packs. */
export const RECOMMENDED_TOLERANCE: Record<RiskRating, number> = { High: 0, Medium: 0.05, Low: 0.1 };

/** §5.3: packs where no exception is tolerated, whatever the risk. */
export const ZERO_TOLERANCE_PACKS: readonly string[] = ['pharma', 'food'];

/** §3.3: a tolerance may not exceed this rate. */
export const TOLERANCE_MAX = 0.25;

export type Selection = TestPlan['selectionMethod'];

/** Context kinds that call for a judgemental sample: the auditor knows where the trouble is. */
const JUDGEMENTAL_KINDS = ['incident', 'prior_finding'];

/** §5.3: how the items are chosen. Annual and quarterly controls are tested in full; a judgemental sample where an incident or prior finding touches the area; else random. */
export function selectionFor(row: Pick<RcmRow, 'frequency' | 'processArea'>, context: EngagementContext | null): { method: Selection; reason: string } {
  if (row.frequency === 'Annual' || row.frequency === 'Quarterly') {
    return { method: 'all', reason: `${row.frequency} frequency` };
  }
  const factor = factorsFor(context, row.processArea).find((f) => JUDGEMENTAL_KINDS.includes(f.kind));
  if (factor) {
    return { method: 'judgemental', reason: `${factor.kind.replace('_', ' ')} touches ${row.processArea}: ${factor.description}` };
  }
  return { method: 'random', reason: `no incident or prior finding touching ${row.processArea}` };
}

/** §5.3: the recommended tolerance for a row: zero for a pharma or food pack, else by the assessed risk. */
export function recommendedTolerance(row: Pick<RcmRow, 'packId'>, assessedRisk: RiskRating): number {
  if (ZERO_TOLERANCE_PACKS.includes(row.packId)) return 0;
  return RECOMMENDED_TOLERANCE[assessedRisk];
}

/** §5.3: the one sentence that says why this sample size and selection were chosen. */
export function samplingRationale(row: Pick<RcmRow, 'frequency'>, assessedRisk: RiskRating, size: number, selection: { method: Selection; reason: string }): string {
  const column = assessedRisk === 'High' ? 'high-risk' : 'lower-risk';
  const head = `Sample of ${size}: a ${row.frequency} control with ${assessedRisk} assessed risk, so the ${column} column of the sample table; ${selection.method} selection because of ${selection.reason}`;
  if (selection.method === 'all') {
    return `${head}; the population count is not recorded, so frequency decides and every item is tested.`;
  }
  return `${head}.`;
}

/** §5.3: the model may only switch random to judgemental; any other change is refused. An unchanged method is accepted. */
export function acceptsSelection(rule: Selection, proposed: Selection): boolean {
  return proposed === rule || (rule === 'random' && proposed === 'judgemental');
}
