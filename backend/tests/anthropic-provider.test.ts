import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, InternalServerError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider, type MessagesClient, type MessagesResponse } from '../src/engine/llm/anthropic';
import { MalformedOutputError, ModelNotSentError, ModelStoppedError, ModelTimeoutError } from '../src/engine/llm/provider';

// A contract test of the real provider against a stubbed SDK client: no network, no model. It pins what the provider
// throws for each way a call can end, since AgentModels charges and retries by those error types (agent spec §6.1, §6.3).

const Out = z.object({ choice: z.number().int(), rationale: z.string() });
const ASK = { system: 'sys', user: 'hello', schema: Out };
const USAGE = { input_tokens: 1200, output_tokens: 300 };
const USED = { inputTokens: 1200, outputTokens: 300 };

type Params = Parameters<MessagesClient['beta']['messages']['create']>;

function answer(text: string | null, stop: MessagesResponse['stop_reason'] = 'end_turn', model = 'claude-opus-5-5'): MessagesResponse {
  return {
    model,
    stop_reason: stop,
    usage: USAGE,
    // Adaptive thinking puts its block ahead of the answer.
    content: [{ type: 'thinking', thinking: '…', signature: 'sig' }, ...(text === null ? [] : [{ type: 'text' as const, text, citations: null }])],
  };
}

function stub(reply: () => MessagesResponse | Promise<MessagesResponse>) {
  const calls: Params[] = [];
  const client: MessagesClient = {
    beta: { messages: { create: async (...args: Params) => { calls.push(args); return reply(); } } },
  };
  return { calls, client };
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

/** A connection error as the SDK raises one: fetch's TypeError, with the socket error (and its code) as its cause. */
const connectionError = (code: string) =>
  new APIConnectionError({ cause: new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) }) });

describe('AnthropicProvider.generate (stubbed SDK client)', () => {
  it('returns the parsed answer, the model that served it and the usage', async () => {
    const { client } = stub(() => answer('{"choice":2,"rationale":"ok"}', 'end_turn', 'claude-sonnet-5-5'));
    const res = await new AnthropicProvider('claude-opus-5-5', client).generate(ASK);
    expect(res).toEqual({ output: { choice: 2, rationale: 'ok' }, servedModel: 'claude-sonnet-5-5', usage: USED });
  });

  it('sends the structured-output format, effort, server-side fallback and per-call limits', async () => {
    const { calls, client } = stub(() => answer('{"choice":0,"rationale":"r"}'));
    await new AnthropicProvider('claude-opus-5-5', client).generate({ ...ASK, maxTokens: 4000, effort: 'low', timeoutMs: 1234, sdkRetries: 0 });
    const [params, options] = calls[0];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 4000, thinking: { type: 'adaptive' }, system: 'sys',
      messages: [{ role: 'user', content: 'hello' }], fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01', 'structured-outputs-2025-12-15'],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(options).toEqual({ timeout: 1234, maxRetries: 0 });
  });

  it('sends no server-side fallback to a Haiku model, and no per-call limits when none are set', async () => {
    const { calls, client } = stub(() => answer('{"choice":0,"rationale":"r"}'));
    await new AnthropicProvider('claude-opus-5-5', client).generate({ ...ASK, model: 'claude-haiku-5-5' });
    const [params, options] = calls[0];
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.fallbacks).toBeUndefined();
    expect(params.betas).toEqual(['structured-outputs-2025-12-15']);
    expect(params.output_config).toMatchObject({ effort: 'high' });
    expect(options).toEqual({});
  });

  it('throws ModelStoppedError with the usage on a refusal, even when the refusal carries text', async () => {
    const { client } = stub(() => answer('I can’t help with that.', 'refusal'));
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelStoppedError);
    expect(err).toMatchObject({ reason: 'refusal', usage: USED });
  });

  it('throws ModelStoppedError with the usage on a max_tokens stop, without parsing the partial JSON', async () => {
    const { client } = stub(() => answer('{"choice":1,"ratio', 'max_tokens'));
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelStoppedError);
    expect(err).toMatchObject({ reason: 'max_tokens', usage: USED });
  });

  it.each([
    ['JSON off the schema', '{"choice":1.5,"rationale":"r"}'],
    ['text that is not JSON', 'Here is my answer: choose 1.'],
    ['no text block at all', null],
  ])('throws MalformedOutputError with the usage for %s', async (_case, text) => {
    const { client } = stub(() => answer(text));
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(MalformedOutputError);
    expect(err).toMatchObject({ usage: USED });
  });

  it.each([
    ['a timeout', () => new APIConnectionTimeoutError()],
    ['an abort', () => new APIUserAbortError()],
  ])('turns %s into ModelTimeoutError, since the server may still bill the call', async (_case, make) => {
    const { client } = stub(() => { throw make(); });
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelTimeoutError);
  });

  it('passes an API error through unchanged', async () => {
    const overloaded = new InternalServerError(529, undefined, 'overloaded', new Headers());
    const { client } = stub(() => { throw overloaded; });
    expect(await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK))).toBe(overloaded);
  });

  it('throws ModelStoppedError with the usage when the context window ran out, without parsing', async () => {
    const { client } = stub(() => answer('{"choice": 1, "rat', 'model_context_window_exceeded'));
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelStoppedError);
    expect(err).toMatchObject({ reason: 'model_context_window_exceeded', usage: USED });
  });

  it('keeps a connection that dropped after sending charged, like a timeout: the server may still bill it', async () => {
    const { client } = stub(() => { throw connectionError('ECONNRESET'); });
    const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect((err as Error).message).toMatch(/may have been sent/);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'])(
    'refunds a call that never got through (%s)',
    async (code) => {
      const { client } = stub(() => { throw connectionError(code); });
      const err = await failure(new AnthropicProvider('claude-opus-5-5', client).generate(ASK));
      expect(err).toBeInstanceOf(ModelNotSentError);
      expect((err as Error).message).toContain(code);
    },
  );

  it('treats a connection error with no cause, or with one cause that may have been sent, as possibly billed', async () => {
    const bare = stub(() => { throw new APIConnectionError({ message: 'Connection error.' }); });
    expect(await failure(new AnthropicProvider('claude-opus-5-5', bare.client).generate(ASK))).toBeInstanceOf(ModelTimeoutError);
    // Happy eyeballs: IPv6 was refused, but IPv4 connected and was then reset.
    const mixed = new APIConnectionError({
      cause: new TypeError('fetch failed', {
        cause: new AggregateError([
          Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        ]),
      }),
    });
    const both = stub(() => { throw mixed; });
    expect(await failure(new AnthropicProvider('claude-opus-5-5', both.client).generate(ASK))).toBeInstanceOf(ModelTimeoutError);
  });
});
