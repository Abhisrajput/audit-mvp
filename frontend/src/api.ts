export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Messages people can act on, for errors where the server's wording is too technical. */
const FRIENDLY: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this engagement while you were working. Reload the page to see their changes, then try again.',
  CSRF_FAILED: 'Your session security token is out of date. Reload the page and try again.',
  REAUTH_REQUIRED: 'Signing needs you to confirm your identity again. Use the Sign buttons, which open the confirmation window.',
  CONTENT_CHANGED: 'This changed after you started signing. Review it again, then sign.',
  AGENT_DISABLED: 'Agent runs are switched off on this server. Ask your administrator.',
  RUN_ACTIVE: 'This engagement already has an agent run. Reload the page to see it.',
  GATE_STALE: 'The workpaper changed after this gate opened. The agent reviews it again and opens a new gate.',
  RUN_NOT_ACTIVE: 'The agent run behind this gate has ended, so the gate can no longer be signed.',
  CONTEXT_LOCKED: 'The scope and RCM are approved, so the engagement context can no longer change. Record late matters in the relevant finding, or start a new engagement.',
  PENDING_ACCESS: 'Your account is waiting for an administrator to assign a role.',
};

export interface ApiInit {
  method?: string;
  body?: unknown;
  /** The engagement version this change is based on; the server refuses it if someone saved since. */
  ifMatch?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Held in memory only — never in localStorage — and refreshed from /api/me after sign-in.
let csrfToken: string | null = null;
let onUnauthenticated: () => void = () => undefined;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

export function requestInit(init: ApiInit = {}): RequestInit {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!SAFE_METHODS.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;
  if (init.ifMatch !== undefined) headers['If-Match'] = `"${init.ifMatch}"`;
  return { method, headers, credentials: 'same-origin', body: init.body === undefined ? undefined : JSON.stringify(init.body) };
}

export function errorFrom(status: number, data: unknown): ApiError {
  const body = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string; requestId?: string };
  const code = body.code ?? null;
  const requestId = body.requestId ?? null;
  const message =
    code === 'INTERNAL'
      ? `Something went wrong on the server.${requestId ? ` If you report it, quote reference ${requestId}.` : ''}`
      : (code && FRIENDLY[code]) || body.error || `HTTP ${status}`;
  return new ApiError(message, status, code, requestId);
}

export async function request<T>(url: string, init: ApiInit = {}): Promise<T> {
  const res = await fetch(url, requestInit(init));
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (res.status === 401) onUnauthenticated();
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

export const api = <T>(path: string, init?: ApiInit) => request<T>(`/api${path}`, init);
