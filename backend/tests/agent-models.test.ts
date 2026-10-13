import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelMeter } from '../src/agents/budget';
import { defaultAgentConfig, loadAgentConfig } from '../src/agents/config';
import { AgentModels, ModelUnavailableError, RETRY_DELAYS_MS } from '../src/agents/llm/models';
import { DEFAULT_PRICES, estimateCall, priceFor } from '../src/agents/llm/prices';
import { AppError } from '../src/errors';
import { NO_SPEND, type Budget, type Spent } from '../src/agents/types';
import { acceptsServerFallback } from '../src/engine/llm/anthropic';
import { MalformedOutputError, ModelStoppedError, type GenerateRequest } from '../src/engine/llm/provider';
import { FakeProvider, TEST_LLM } from './helpers';

const Out = z.object({ answer: z.string() });
const ASK = { system: 'sys', user: 'hello', schema: Out };
const BUDGET: Budget = { maxSteps: 10, maxTokens: 100_000, maxCostUsd: 10 };
// 8 prompt characters → 3 tokens in; the whole 500-token ceiling out; $10 per million tokens each way.
const ESTIMATE: Spent = { steps: 0, tokensIn: 3, tokensOut: 500, costUsd: 0.00503 };
// The fake model reports 1000 tokens in and 200 out.
const USED: Spent = { steps: 0, tokensIn: 1000, tokensOut: 200, costUsd: 0.012 };

function setup(handler: (req: GenerateRequest<any>, call: number) => unknown, budget = BUDGET, opts: ConstructorParameters<typeof FakeProvider>[1] = {}) {
  const written: Spent[] = [];
  const waits: number[] = [];
  const fake = new FakeProvider(handler, opts);
  const models = new AgentModels(fake, TEST_LLM, new ModelMeter(budget, NO_SPEND, async (s) => { written.push(s); }), { wait: async (ms) => { waits.push(ms); } });
  return { fake, models, written, waits };
}

describe('prices and estimates', () => {
  it('estimates a call high: a token per three prompt characters, and the whole output ceiling', () => {
    expect(estimateCall(DEFAULT_PRICES, 'claude-opus-5-5', 3000, 1000)).toEqual({ tokensIn: 1000, tokensOut: 1000, costUsd: 0.024 });
    expect(() => priceFor(DEFAULT_PRICES, 'claude-unknown')).toThrow(/No price for model claude-unknown/);
  });

  it('sends the server-side fallback only to models that accept it', () => {
    expect(acceptsServerFallback('claude-opus-5-5')).toBe(true);
    expect(acceptsServerFallback('claude-sonnet-5-5')).toBe(true);
    expect(acceptsServerFallback('claude-haiku-5-5')).toBe(false);
  });
});

describe('agent model settings [REQ-25]', () => {
  it('default to a model, effort and output ceiling per role, and to the built-in prices', () => {
    expect(defaultAgentConfig().llm).toEqual({
      roles: {
        policy: { model: 'claude-sonnet-5-5', maxTokens: 4000, effort: 'low' },
        qa: { model: 'claude-opus-5-5', maxTokens: 16000, effort: 'high' },
        'test-plan': { model: 'claude-sonnet-5-5', maxTokens: 16000, effort: 'medium' },
        specialist: { model: 'claude-opus-5-5', maxTokens: 16000, effort: 'high' },
      },
      prices: DEFAULT_PRICES,
      timeoutMs: 120_000,
    });
  });

  it('take overrides, merge price overrides over the built-in table, and refuse a model without a price', () => {
    const cfg = loadAgentConfig({ AGENT_QA_MODEL: 'claude-sonnet-5-5', AGENT_MODEL_PRICES: '{"claude-opus-5-5":{"inputPerMTok":5,"outputPerMTok":25}}' });
    expect(cfg.llm.roles.qa.model).toBe('claude-sonnet-5-5');
    expect(cfg.llm.prices['claude-opus-5-5']).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(cfg.llm.prices['claude-sonnet-5-5']).toEqual(DEFAULT_PRICES['claude-sonnet-5-5']);
    expect(() => loadAgentConfig({ AGENT_MODEL_PRICES: 'not json' })).toThrow(/AGENT_MODEL_PRICES/);
    expect(() => loadAgentConfig({ AGENT_MODEL_PRICES: '{"x":{"inputPerMTok":-1,"outputPerMTok":1}}' })).toThrow(/AGENT_MODEL_PRICES/);
    expect(() => loadAgentConfig({ LLM_PROVIDER: 'anthropic', AGENT_POLICY_MODEL: 'claude-mystery' })).toThrow(/AGENT_POLICY_MODEL: no price for model claude-mystery/);
    // Offline, nothing is called, so an unpriced model is not an error.
    expect(loadAgentConfig({ AGENT_POLICY_MODEL: 'claude-mystery' }).llm.roles.policy.model).toBe('claude-mystery');
  });

  it('refuses an unpriced model only when agents are enabled, so a disabled agent never stops the API from starting', () => {
    const unlisted = { LLM_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'claude-mystery' };
    expect(() => loadAgentConfig({ ...unlisted, AGENT_ENABLED: 'true' })).toThrow(/ANTHROPIC_MODEL: no price for model claude-mystery/);
    expect(() => loadAgentConfig({ ...unlisted, AGENT_ENABLED: 'false' })).not.toThrow();
    expect(loadAgentConfig({ ...unlisted, AGENT_ENABLED: 'false' }).enabled).toBe(false);
  });
});

describe('agent model calls [REQ-29]', () => {
  it('charges a call at its estimate before it is made, then settles it to what it used', async () => {
    const { fake, models, written } = setup(() => ({ answer: 'yes' }));
    expect(await models.generate('policy', ASK)).toEqual({ output: { answer: 'yes' }, servedModel: 'fake-1' });
    expect(written).toEqual([ESTIMATE, USED]);
    expect(fake.requests[0]).toMatchObject({ model: 'fake-1', maxTokens: 500, effort: 'low', timeoutMs: 1000, sdkRetries: 0 });
    expect(models.take()).toEqual({ tokensIn: 1000, tokensOut: 200, costUsd: 0.012, model: 'fake-1' });
    expect(models.take()).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: null });
  });

  it('retries a failing model three times with backoff, refunds each failure, then gives up', async () => {
    const { fake, models, written, waits } = setup(() => { throw new Error('overloaded'); });
    await expect(models.generate('qa', ASK)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fake.requests).toHaveLength(4);
    expect(waits).toEqual(RETRY_DELAYS_MS);
    expect(written.at(-1)).toEqual(NO_SPEND);
  });

  it('recovers when a retry succeeds', async () => {
    const { fake, models, waits } = setup((_req, call) => { if (call === 1) throw new Error('timeout'); return { answer: 'ok' }; });
    expect((await models.generate('qa', ASK)).output).toEqual({ answer: 'ok' });
    expect(fake.requests).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it('does not retry a malformed answer, and keeps it charged at the estimate', async () => {
    const { fake, models, written } = setup(() => ({ nope: 1 }));
    await expect(models.generate('policy', ASK)).rejects.toBeInstanceOf(MalformedOutputError);
    expect(fake.requests).toHaveLength(1);
    expect(written.at(-1)).toEqual(ESTIMATE);
    expect(models.take()).toMatchObject({ tokensIn: 3, tokensOut: 500 });
  });

  it('refuses a call the budget cannot cover before sending anything', async () => {
    const { fake, models } = setup(() => ({ answer: 'yes' }), { maxSteps: 10, maxTokens: 100_000, maxCostUsd: 0.001 });
    await expect(models.generate('policy', ASK)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('prices a call by the model that served it, or by the model asked for when that one has no price', async () => {
    const { models } = setup(() => ({ answer: 'yes' }), BUDGET, { servedModel: 'claude-mystery' });
    expect((await models.generate('policy', ASK)).servedModel).toBe('claude-mystery');
    expect(models.take()).toEqual({ tokensIn: 1000, tokensOut: 200, costUsd: 0.012, model: 'claude-mystery' });
  });

  it('gives the specialist modules a provider whose calls are charged and retried the same way', async () => {
    const { fake, models, written } = setup(() => ({ answer: 'drafted' }));
    const provider = models.forModules()!;
    expect(provider.model).toBe('fake-1');
    expect((await provider.generate(ASK)).output).toEqual({ answer: 'drafted' });
    expect(fake.requests[0]).toMatchObject({ model: TEST_LLM.roles.specialist.model, sdkRetries: 0 });
    expect(written).toEqual([ESTIMATE, USED]);
  });

  it('has nothing to call offline', async () => {
    const models = new AgentModels(null, TEST_LLM, new ModelMeter(BUDGET, NO_SPEND, async () => {}));
    expect(models.available).toBe(false);
    expect(models.forModules()).toBeNull();
    await expect(models.generate('policy', ASK)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('re-throws a lost lease when settling a call, leaving the estimate charged', async () => {
    const written: Spent[] = [];
    let writes = 0;
    const persist = async (s: Spent) => {
      if (++writes === 2) throw new AppError(409, 'The run lease was lost', 'LEASE_LOST');
      written.push(s);
    };
    const fake = new FakeProvider(() => ({ answer: 'yes' }));
    const models = new AgentModels(fake, TEST_LLM, new ModelMeter(BUDGET, NO_SPEND, persist));
    await expect(models.generate('policy', ASK)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(fake.requests).toHaveLength(1);
    expect(written).toEqual([ESTIMATE]);
  });

  it.each(['max_tokens', 'refusal'] as const)('charges a %s stop at its real usage and does not retry it', async (reason) => {
    const { fake, models, written, waits } = setup(() => { throw new ModelStoppedError('stopped', reason, { inputTokens: 1000, outputTokens: 200 }); });
    await expect(models.generate('qa', ASK)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(written).toEqual([ESTIMATE, USED]);
    expect(models.take()).toMatchObject({ tokensIn: 1000, tokensOut: 200 });
  });

  it('charges a stop that reports no usage at its estimate', async () => {
    const { fake, models, written } = setup(() => { throw new ModelStoppedError('stopped', 'max_tokens'); });
    await expect(models.generate('qa', ASK)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fake.requests).toHaveLength(1);
    expect(written.at(-1)).toEqual(ESTIMATE);
  });
});
