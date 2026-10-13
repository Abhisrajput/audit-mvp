import { z } from 'zod';
import type { Budget } from './types';

// Agent settings (spec §6), from the environment and validated at start-up like every other setting (REQ-25).

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export interface AgentConfig {
  /** AGENT_ENABLED=false is the kill switch: no new runs, and workers lease nothing. */
  enabled: boolean;
  /** A run's default budget, and the most its starter may ask for. */
  budget: Budget;
  qaThreshold: number;
  pollMs: number;
  concurrency: number;
  leaseMs: number;
  heartbeatMs: number;
}

const Env = z.object({
  AGENT_ENABLED: z.enum(['true', 'false']).default('true'),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).default(200),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1).default(2_000_000),
  AGENT_MAX_COST_USD: z.coerce.number().positive().default(25),
  AGENT_QA_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
  AGENT_POLL_MS: z.coerce.number().int().min(100).default(3000),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const v = parsed.data;
  return {
    enabled: v.AGENT_ENABLED === 'true',
    budget: { maxSteps: v.AGENT_MAX_STEPS, maxTokens: v.AGENT_MAX_TOKENS, maxCostUsd: v.AGENT_MAX_COST_USD },
    qaThreshold: v.AGENT_QA_THRESHOLD,
    pollMs: v.AGENT_POLL_MS,
    concurrency: v.AGENT_WORKER_CONCURRENCY,
    leaseMs: LEASE_MS,
    heartbeatMs: HEARTBEAT_MS,
  };
}

export const defaultAgentConfig = (): AgentConfig => loadAgentConfig({});
