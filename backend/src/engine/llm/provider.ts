import type { z } from 'zod';

// Model-agnostic provider interface. Modules always have a deterministic
// offline path; when a provider is configured they ask it for a structured
// draft and the engine's QA gates check the result exactly as they would the
// offline output. Add Azure OpenAI / Foundry etc. by implementing this.

export interface GenerateRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface GenerateResult<T> {
  output: T;
  /** Model that actually served the request (may differ after a fallback). */
  servedModel: string;
  /** Tokens the call used, when the provider reports them (metrics only). */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export class ProviderError extends Error {}
