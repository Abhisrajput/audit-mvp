import type { Kysely } from 'kysely';
import type { DB } from '../db/schema';
import { agentCostUsd, agentGuardRefusals, agentPolicyFallbacks, agentRuns, agentStepSeconds, agentTokens } from '../observability/metrics';
import type { AgentLlmConfig } from './config';
import type { AgentStep } from './run-repo';
import type { Decision, RunStatus } from './types';

// Agent metrics (spec §6.4), counted from steps once they are committed, so a rolled-back or fenced-off write is never
// counted. Label values are bounded: step kinds, agent names, model ids and fixed reasons. A run, engagement or user id,
// or a tool name a model made up, never becomes a label.

const STATUSES: readonly RunStatus[] = ['running', 'runnable', 'waiting', 'needs_human', 'completed', 'cancelled', 'failed'];

/** Why the rules decided for a model policy, or null when they did not take over (spec §6.3). */
export function fallbackReason(d: Decision): string | null {
  if (d.policy !== 'rules' || !d.attempts?.length) return null;
  return d.attempts[d.attempts.length - 1].outcome;
}

/**
 * Milliseconds since `since`, at least 1. A timed step always reads above 0, because 0 marks a bookkeeping step
 * (takeover note, rails refusal, refused lookup) that observeSteps leaves out of the duration histogram.
 */
export const elapsedMs = (since: number): number => Math.max(1, Date.now() - since);

/**
 * The model label for a charged step: the id when it is a configured role model or in the price table, else 'other'.
 * The id comes from the provider's response, so a server-side fallback or a gateway must not add series.
 */
export function modelLabel(model: string | null, llm?: AgentLlmConfig): string {
  if (!model) return 'none';
  if (!llm) return model;
  const configured = Object.values(llm.roles).some((r) => r.model === model);
  return configured || Object.hasOwn(llm.prices, model) ? model : 'other';
}

/** Counts one iteration's committed steps. `llm` bounds the model label to the configured and priced models. */
export function observeSteps(steps: AgentStep[], llm?: AgentLlmConfig): void {
  for (const s of steps) {
    // Bookkeeping steps (takeover notes, rails refusals, refused lookups) record 0 ms: no timing to count.
    if (s.durationMs > 0) agentStepSeconds.observe({ kind: s.kind }, s.durationMs / 1000);
    const model = modelLabel(s.model, llm);
    if (s.tokensIn) agentTokens.inc({ agent: s.agent, model, kind: 'input' }, s.tokensIn);
    if (s.tokensOut) agentTokens.inc({ agent: s.agent, model, kind: 'output' }, s.tokensOut);
    if (s.costUsd) agentCostUsd.inc({ agent: s.agent, model }, s.costUsd);
    if (s.kind === 'decision') {
      const reason = fallbackReason(s.decision as Decision);
      if (reason) agentPolicyFallbacks.inc({ reason });
    }
    if (s.kind === 'tool_call' && (s.decision as { refused?: unknown } | null)?.refused) {
      agentGuardRefusals.inc({ source: s.agent === 'rails' ? 'rails' : 'model_request' });
    }
  }
}

/** Sets runs by status from the database. A status with no runs reads 0, so its series never goes missing. */
export async function refreshRunGauge(db: Kysely<DB>): Promise<void> {
  const rows = await db
    .selectFrom('agent_runs')
    .select((eb) => ['status', eb.fn.countAll<string>().as('n')])
    .groupBy('status')
    .execute();
  const counts = new Map(rows.map((r) => [r.status, Number(r.n)]));
  for (const status of STATUSES) agentRuns.set({ status }, counts.get(status) ?? 0);
}
