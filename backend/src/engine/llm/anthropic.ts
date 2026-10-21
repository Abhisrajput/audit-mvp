import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { GenerateRequest, GenerateResult, LlmProvider } from './provider';
import { DEFAULT_MAX_TOKENS, MalformedOutputError, ModelNotSentError, ModelStoppedError, ModelTimeoutError } from './provider';

/** Claude Haiku has no server-side refusal fallback; the other current models accept `fallbacks: 'default'`. */
export const acceptsServerFallback = (model: string) => !model.includes('haiku');

/** The beta that structured outputs need. `messages.parse()` adds it by itself; `messages.create()` does not. */
const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15';
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Socket and TLS error codes that mean the request never reached the API, so nothing can have been billed: the name did
 * not resolve, the connection was refused, or the TLS handshake failed before any of the request was written. Each
 * handshake code is named, because the `ERR_TLS_` and `ERR_SSL_` families also hold failures of an open connection (a
 * bad record MAC, a refused renegotiation), after which the request may have been sent. Only certificate verification
 * (`CERT_*`, `UNABLE_TO_*`, the self-signed codes) is a whole family that can only happen during the handshake.
 */
const NOT_SENT = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_TLS_INVALID_PROTOCOL_VERSION', 'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  'ERR_TLS_REQUIRED_SERVER_NAME', 'ERR_TLS_SNI_FROM_SERVER', 'ERR_TLS_DH_PARAM_SIZE',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_UNSUPPORTED_PROTOCOL', 'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
]);
const notSent = (code: string) => NOT_SENT.has(code) || /^(CERT_|UNABLE_TO_)/.test(code);

/** Every `code` along an error's causes. fetch puts the socket error under its TypeError; an AggregateError holds several. */
export function causeCodes(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 8) return [];
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  return [
    ...(typeof e.code === 'string' ? [e.code] : []),
    ...(Array.isArray(e.errors) ? e.errors.flatMap((x) => causeCodes(x, depth + 1)) : []),
    ...causeCodes(e.cause, depth + 1),
  ];
}

/** True only when every cause says the request never got through. Anything else may have been sent, and billed. */
export function neverSent(err: unknown): boolean {
  const codes = causeCodes(err);
  return codes.length > 0 && codes.every(notSent);
}

/** The parts of a beta message the provider reads. */
export type MessagesResponse = Pick<Anthropic.Beta.BetaMessage, 'content' | 'model' | 'stop_reason'> & {
  usage: Pick<Anthropic.Beta.BetaUsage, 'input_tokens' | 'output_tokens'>;
};

/** The one SDK call the provider makes. An Anthropic client is one; tests pass a stub. */
export interface MessagesClient {
  beta: { messages: { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<MessagesResponse> } };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client: MessagesClient;

  constructor(readonly model = 'claude-opus-5-5', client?: MessagesClient) {
    this.client = client ?? new Anthropic();
  }

  /**
   * One structured call. The answer is checked here rather than by `messages.parse()`, which parses before the stop
   * reason can be read and throws one generic error for a refusal, a truncation and an off-schema answer alike. So:
   * a refusal or truncation throws ModelStoppedError, an answer that is not the schema's JSON throws
   * MalformedOutputError, a timeout, an abort or a connection lost after sending throws ModelTimeoutError, and a
   * connection that never got through throws ModelNotSentError, each carrying what the caller needs to charge it. The
   * API's own errors are passed on unchanged.
   */
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const model = req.model ?? this.model;
    const fallback = acceptsServerFallback(model);
    let response: MessagesResponse;
    try {
      response = await this.client.beta.messages.create(
        {
          model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          // If the primary model declines, the API re-runs the request on its
          // recommended fallback model; the served model is recorded in the trail.
          betas: fallback ? [SERVER_FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA] : [STRUCTURED_OUTPUTS_BETA],
          fallbacks: fallback ? 'default' : undefined,
          thinking: { type: 'adaptive' },
          output_config: { effort: req.effort ?? 'high', format: betaZodOutputFormat(req.schema) },
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        { ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}), ...(req.sdkRetries !== undefined ? { maxRetries: req.sdkRetries } : {}) },
      );
    } catch (err) {
      // Sent but not answered in time: the server may still run the request and bill it.
      if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
        throw new ModelTimeoutError(`Model call timed out or was aborted: ${err.message}`);
      }
      if (err instanceof APIConnectionError) {
        // A connection that failed before the request reached the API is not billed. One that failed later (reset,
        // closed mid-answer) may have been, so it is charged like a timeout: an over-count at most.
        if (neverSent(err)) throw new ModelNotSentError(`Model call could not be sent (${causeCodes(err).join(', ')}): ${err.message}`);
        throw new ModelTimeoutError(`Connection to the model failed after the request may have been sent: ${err.message}`);
      }
      throw err;
    }

    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === 'refusal') {
      throw new ModelStoppedError('Model declined the request; no draft produced.', 'refusal', usage);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ModelStoppedError('Model output was truncated (max_tokens); no draft produced.', 'max_tokens', usage);
    }
    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new ModelStoppedError('Model ran out of context window; no draft produced.', 'model_context_window_exceeded', usage);
    }
    // The first text block is the answer, as messages.parse() reads it; adaptive thinking comes before it.
    const text = response.content.find((b) => b.type === 'text');
    if (!text) throw new MalformedOutputError('Model answered without any text.', usage);
    let output: T;
    try {
      const parsed = req.schema.safeParse(JSON.parse(text.text));
      if (!parsed.success) throw new Error(parsed.error.message);
      output = parsed.data;
    } catch (err) {
      throw new MalformedOutputError(`Model output did not match the required schema: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000), usage);
    }
    return { output, servedModel: response.model, usage };
  }
}
