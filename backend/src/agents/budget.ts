import { AppError } from '../errors';
import type { Budget, Spent } from './types';

// Run budgets (spec §6.1). Checked before every iteration and before every model call, so a run never starts a step
// it cannot pay for.

/**
 * Why the run may not take another step, or null. `maxSteps` counts loop iterations (one decision and what it led to),
 * not agent_steps rows: an iteration writes a decision step and usually one or more delegate, qa or tool_call steps.
 */
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

/**
 * Charges a run's model calls (spec §6.1). Each call is reserved at its estimate before it is made, which refuses a call
 * the budget cannot cover, and settled to what it actually used after it returns. Both are written to the run at once
 * (`persist`), so a worker that dies mid-call leaves the estimate charged rather than the call unpaid for.
 */
export class ModelMeter {
  private current: Spent;

  constructor(private readonly budget: Budget, spent: Spent, private readonly persist: (spent: Spent) => Promise<void>) {
    this.current = spent;
  }

  get spent(): Spent {
    return this.current;
  }

  async reserve(estimate: Partial<Spent>): Promise<void> {
    const problem = budgetProblem(this.budget, this.current, estimate);
    if (problem) throw new AppError(409, problem, 'BUDGET_EXHAUSTED');
    this.current = addSpend(this.current, estimate);
    await this.persist(this.current);
  }

  /** Replaces a reservation with what the call used. A call that failed used nothing: pass `{}`. */
  async settle(estimate: Partial<Spent>, actual: Partial<Spent>): Promise<void> {
    this.current = addSpend(this.current, {
      tokensIn: (actual.tokensIn ?? 0) - (estimate.tokensIn ?? 0),
      tokensOut: (actual.tokensOut ?? 0) - (estimate.tokensOut ?? 0),
      costUsd: (actual.costUsd ?? 0) - (estimate.costUsd ?? 0),
    });
    await this.persist(this.current);
  }
}
