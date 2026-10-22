import { z } from 'zod';

// Assistant settings (spec §9), from the environment and validated at start-up like every other setting.

export interface AssistantConfig {
  /** ASSISTANT_ENABLED=false is the kill switch: both POST routes answer 503. */
  enabled: boolean;
  /** The model that plans a turn; used only when a model provider is configured. */
  model: string;
  timeoutMs: number;
}

const Env = z.object({
  ASSISTANT_ENABLED: z.enum(['true', 'false']).default('true'),
  ASSISTANT_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  ASSISTANT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
});

export function loadAssistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  // Compose passes unset optional settings as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const v = parsed.data;
  return { enabled: v.ASSISTANT_ENABLED === 'true', model: v.ASSISTANT_MODEL, timeoutMs: v.ASSISTANT_MODEL_TIMEOUT_MS };
}

export const defaultAssistantConfig = (): AssistantConfig => loadAssistantConfig({});
