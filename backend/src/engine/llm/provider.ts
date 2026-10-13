import type { z } from 'zod';

// Model-agnostic provider interface. Modules always have a deterministic
// offline path; when a provider is configured they ask it for a structured
// draft and the engine's QA gates check the result exactly as they would the
// offline output. Add Azure OpenAI / Foundry etc. by implementing this.

export interface GenerateRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** This call's model instead of the provider's own (agent roles pick theirs). */
  model?: string;
  /** Output ceiling, thinking included. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Time limit for this call. Running out is a model error like any other. */
  timeoutMs?: number;
  /** Retries the SDK makes by itself. Agent calls pass 0: they retry on their own (agent spec §6.3). */
  sdkRetries?: number;
}

/** The output ceiling of a call that does not set one. */
export const DEFAULT_MAX_TOKENS = 16000;

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

/**
 * The model answered, but not in the required shape (agent spec §6.3: "malformed"). The call is billed, so the usage
 * it reports travels with the error when the provider knows it.
 */
export class MalformedOutputError extends ProviderError {
  constructor(message: string, readonly usage?: { inputTokens: number; outputTokens: number }) {
    super(message);
  }
}

/**
 * The call ran out of time, or was aborted, after it was sent. The server may still finish it and bill it, so it is
 * charged like a call that ran (agent spec §6.1), though it is retried like any other model error (§6.3).
 */
export class ModelTimeoutError extends ProviderError {}

/**
 * The model ran but stopped without an answer: it declined, or ran out of output tokens. The call is billed, so the
 * usage it reports travels with the error.
 */
export class ModelStoppedError extends ProviderError {
  constructor(message: string, readonly reason: 'refusal' | 'max_tokens', readonly usage?: { inputTokens: number; outputTokens: number }) {
    super(message);
  }
}
