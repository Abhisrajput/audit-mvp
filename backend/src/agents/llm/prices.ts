import type { Spent } from '../types';

// What model calls cost, for the budget checks before each call (spec §6.1).

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens (thinking included). */
  outputPerMTok: number;
}

export type PriceTable = Record<string, ModelPrice>;

// VERIFY every row: copied from Anthropic's published first-party list prices as cached on 2026-10-06. They are not
// billing figures. Check https://www.anthropic.com/pricing before relying on budgets in production, and set
// AGENT_MODEL_PRICES where the deployment pays other rates (Amazon Bedrock, Google Vertex AI, a negotiated rate).
export const DEFAULT_PRICES: PriceTable = Object.freeze({
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 }, // VERIFY
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 }, // VERIFY
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 }, // VERIFY: prompts up to 100K tokens; $0.50 / $2.50 above
});

/** What one call cost, to a millionth of a dollar. */
export const callCost = (p: ModelPrice, tokensIn: number, tokensOut: number) => Math.round(tokensIn * p.inputPerMTok + tokensOut * p.outputPerMTok) / 1e6;

/** The price of `model`, or of `fallbackModel` when `model` is not listed (a server-side fallback served the call). */
export function priceFor(prices: PriceTable, model: string, fallbackModel?: string): ModelPrice {
  const p = prices[model] ?? (fallbackModel ? prices[fallbackModel] : undefined);
  if (!p) throw new Error(`No price for model ${model}; add it to AGENT_MODEL_PRICES`);
  return p;
}

/** A deliberately high estimate of one call: about a token per three characters of prompt, and the whole output ceiling. */
export function estimateCall(prices: PriceTable, model: string, promptChars: number, maxTokens: number): Pick<Spent, 'tokensIn' | 'tokensOut' | 'costUsd'> {
  const tokensIn = Math.ceil(promptChars / 3);
  return { tokensIn, tokensOut: maxTokens, costUsd: callCost(priceFor(prices, model), tokensIn, maxTokens) };
}
