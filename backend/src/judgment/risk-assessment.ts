// Engagement risk assessment (spec §5.1). The library gives each control a rating;
// the auditor's context can raise it, one step per kind of fact that applies. Ratings
// never go down. This file is pure: no I/O, no database, no model calls.

import type { Control, EngagementContext, RiskRating, ScopeItem } from '../engine/types';
import { factorsFor } from './context';

/** Ratings from lowest to highest, so a step is a move along this list. */
const LEVELS: RiskRating[] = ['Low', 'Medium', 'High'];

/** Raise a rating by some steps, never above High. */
export function stepUp(rating: RiskRating, steps: number): RiskRating {
  const index = Math.min(LEVELS.indexOf(rating) + steps, LEVELS.length - 1);
  return LEVELS[index];
}

export interface Assessed { assessedRisk: RiskRating; riskFactors: string[] }

/** §5.1: one step per distinct factor kind among the factors that apply to the control's area. */
export function assessControl(control: Pick<Control, 'processArea' | 'riskRating'>, context: EngagementContext | null): Assessed {
  const applicable = factorsFor(context, control.processArea);
  const kinds = new Set(applicable.map((factor) => factor.kind)).size;
  return {
    assessedRisk: stepUp(control.riskRating, kinds),
    riskFactors: applicable.map((factor) => factor.description),
  };
}

/** Max over the items of one area; 'Low' for an empty list. */
export function areaRisk(items: Pick<ScopeItem, 'assessedRisk'>[]): RiskRating {
  return items.reduce<RiskRating>(
    (highest, item) => (LEVELS.indexOf(item.assessedRisk) > LEVELS.indexOf(highest) ? item.assessedRisk : highest),
    'Low',
  );
}

/** True when some factor applies to the process area, so the context has something to say about it. */
export function isTouched(context: EngagementContext | null, processArea: string): boolean {
  return factorsFor(context, processArea).length > 0;
}
