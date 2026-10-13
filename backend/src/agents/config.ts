import { z } from 'zod';
import { DEFAULT_PRICES, type PriceTable } from './llm/prices';
import type { Budget } from './types';

// Agent settings (spec §6), from the environment and validated at start-up like every other setting (REQ-25).

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

/** Who is asking: each role has its own model, output ceiling and effort. */
export type ModelRole = 'policy' | 'qa' | 'test-plan' | 'specialist';

export interface RoleSettings {
  model: string;
  /** Output ceiling of one call, thinking included. Also the output part of the call's budget estimate. */
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
}

export interface AgentLlmConfig {
  roles: Record<ModelRole, RoleSettings>;
  prices: PriceTable;
  timeoutMs: number;
}

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
  /** Model settings for agent calls; used only when a model provider is configured. */
  llm: AgentLlmConfig;
}

const Env = z.object({
  AGENT_ENABLED: z.enum(['true', 'false']).default('true'),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).default(200),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1).default(2_000_000),
  AGENT_MAX_COST_USD: z.coerce.number().positive().default(25),
  AGENT_QA_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
  AGENT_POLL_MS: z.coerce.number().int().min(100).default(3000),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  LLM_PROVIDER: z.string().default('offline'),
  AGENT_POLICY_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  AGENT_QA_MODEL: z.string().min(1).default('claude-opus-5-5'),
  AGENT_TEST_PLAN_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  AGENT_MODEL_PRICES: z.string().optional(),
});

const PriceOverrides = z.record(z.string(), z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }).strict());

/** The built-in prices, with AGENT_MODEL_PRICES merged over them. */
function loadPrices(raw: string | undefined): PriceTable {
  if (!raw) return { ...DEFAULT_PRICES };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Invalid configuration:\n  - AGENT_MODEL_PRICES: not valid JSON');
  }
  const parsed = PriceOverrides.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid configuration:\n  - AGENT_MODEL_PRICES: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return { ...DEFAULT_PRICES, ...parsed.data };
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  // Compose passes unset optional settings as empty strings; treat them as absent (as the core config does).
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const v = parsed.data;
  const prices = loadPrices(v.AGENT_MODEL_PRICES);
  const roles: AgentLlmConfig['roles'] = {
    policy: { model: v.AGENT_POLICY_MODEL, maxTokens: 4000, effort: 'low' },
    qa: { model: v.AGENT_QA_MODEL, maxTokens: 16000, effort: 'high' },
    'test-plan': { model: v.AGENT_TEST_PLAN_MODEL, maxTokens: 16000, effort: 'medium' },
    specialist: { model: v.ANTHROPIC_MODEL, maxTokens: 16000, effort: 'high' },
  };
  // A model that will be called must have a price, or its calls could not be checked against the budget. This applies
  // only when agents run: server.ts loads this config too, and a disabled agent must not stop the API from starting.
  if (v.AGENT_ENABLED === 'true' && v.LLM_PROVIDER !== 'offline') {
    const envOf: Record<ModelRole, string> = { policy: 'AGENT_POLICY_MODEL', qa: 'AGENT_QA_MODEL', 'test-plan': 'AGENT_TEST_PLAN_MODEL', specialist: 'ANTHROPIC_MODEL' };
    const unpriced = (Object.keys(roles) as ModelRole[]).filter((r) => !prices[roles[r].model]);
    if (unpriced.length) {
      throw new Error(`Invalid configuration:\n${unpriced.map((r) => `  - ${envOf[r]}: no price for model ${roles[r].model}; add it to AGENT_MODEL_PRICES`).join('\n')}`);
    }
  }
  return {
    enabled: v.AGENT_ENABLED === 'true',
    budget: { maxSteps: v.AGENT_MAX_STEPS, maxTokens: v.AGENT_MAX_TOKENS, maxCostUsd: v.AGENT_MAX_COST_USD },
    qaThreshold: v.AGENT_QA_THRESHOLD,
    pollMs: v.AGENT_POLL_MS,
    concurrency: v.AGENT_WORKER_CONCURRENCY,
    leaseMs: LEASE_MS,
    heartbeatMs: HEARTBEAT_MS,
    llm: { roles, prices, timeoutMs: v.AGENT_MODEL_TIMEOUT_MS },
  };
}

export const defaultAgentConfig = (): AgentConfig => loadAgentConfig({});
