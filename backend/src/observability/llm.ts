import type { LlmProvider } from '../engine/llm/provider';
import { llmCalls, llmFallbacks, llmTokens } from './metrics';

/**
 * Counts a provider's calls, fallbacks and tokens without changing what it returns or throws. A failed call is a
 * deterministic fallback: the module then drafts with its offline rules (engine/modules/llm-step.ts).
 */
export function instrumentProvider(p: LlmProvider | null): LlmProvider | null {
  if (!p) return null;
  const provider = p.id;
  return {
    id: p.id,
    model: p.model,
    async generate(req) {
      try {
        const res = await p.generate(req);
        llmCalls.inc({ provider, outcome: 'ok' });
        if (res.servedModel !== p.model) llmFallbacks.inc({ provider, kind: 'model' });
        if (res.usage) {
          llmTokens.inc({ provider, kind: 'input' }, res.usage.inputTokens);
          llmTokens.inc({ provider, kind: 'output' }, res.usage.outputTokens);
        }
        return res;
      } catch (err) {
        llmCalls.inc({ provider, outcome: 'error' });
        llmFallbacks.inc({ provider, kind: 'deterministic' });
        throw err;
      }
    },
  };
}
