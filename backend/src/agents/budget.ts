import { AppError } from '../errors';
import type { Budget, Spent } from './types';

// Run budgets (spec §6.1). Checked before every iteration and before every model call, so a run never starts a step
// it cannot pay for.

/** Why the run may not take another step, or null. */
export function budgetProblem(budget: Budget, spent: Spent, estimate: Partial<Spent> = {}): string | null {
  if (spent.steps + 1 > budget.maxSteps) return `budget_exhausted: ${budget.maxSteps} steps`;
  const tokens = spent.tokensIn + spent.tokensOut + (estimate.tokensIn ?? 0) + (estimate.tokensOut ?? 0);
  if (tokens > budget.maxTokens) return `budget_exhausted: ${budget.maxTokens} tokens`;
  if (spent.costUsd + (estimate.costUsd ?? 0) > budget.maxCostUsd) return `budget_exhausted: $${budget.maxCostUsd}`;
  return null;
}

export function addSpend(a: Spent, b: Partial<Spent>): Spent {
  return {
    steps: a.steps + (b.steps ?? 0),
    tokensIn: a.tokensIn + (b.tokensIn ?? 0),
    tokensOut: a.tokensOut + (b.tokensOut ?? 0),
    costUsd: Math.round((a.costUsd + (b.costUsd ?? 0)) * 1e6) / 1e6,
  };
}

/** A run's budget: the configured one, lowered where its starter asked. Raising it is an audit manager's call, later. */
export function lowerBudget(ceiling: Budget, requested: Partial<Budget> = {}): Budget {
  const out: Budget = {
    maxSteps: requested.maxSteps ?? ceiling.maxSteps,
    maxTokens: requested.maxTokens ?? ceiling.maxTokens,
    maxCostUsd: requested.maxCostUsd ?? ceiling.maxCostUsd,
  };
  for (const k of ['maxSteps', 'maxTokens', 'maxCostUsd'] as const) {
    if (!(out[k] > 0)) throw new AppError(400, `${k} must be greater than 0`);
    if (out[k] > ceiling[k]) throw new AppError(400, `${k} may not exceed ${ceiling[k]}; an audit manager can raise a run's budget once it has started`);
  }
  return out;
}
