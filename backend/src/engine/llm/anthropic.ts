import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { GenerateRequest, GenerateResult, LlmProvider } from './provider';
import { DEFAULT_MAX_TOKENS, MalformedOutputError, ProviderError } from './provider';

/** Claude Haiku has no server-side refusal fallback; the other current models accept `fallbacks: 'default'`. */
export const acceptsServerFallback = (model: string) => !model.includes('haiku');

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client: Anthropic;

  constructor(readonly model = 'claude-opus-5-5') {
    this.client = new Anthropic();
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const model = req.model ?? this.model;
    const fallback = acceptsServerFallback(model);
    const response = await this.client.beta.messages.parse(
      {
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        // If the primary model declines, the API re-runs the request on its
        // recommended fallback model; the served model is recorded in the trail.
        betas: fallback ? ['server-side-fallback-2026-07-01'] : undefined,
        fallbacks: fallback ? 'default' : undefined,
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort ?? 'high', format: betaZodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      { ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}), ...(req.sdkRetries !== undefined ? { maxRetries: req.sdkRetries } : {}) },
    );

    if (response.stop_reason === 'refusal') {
      throw new ProviderError('Model declined the request; no draft produced.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ProviderError('Model output was truncated (max_tokens); no draft produced.');
    }
    if (response.parsed_output == null) {
      throw new MalformedOutputError('Model output did not match the required schema.');
    }
    return {
      output: response.parsed_output as T,
      servedModel: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
