export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Messages people can act on, for errors where the server's wording is too technical. */
const FRIENDLY: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this engagement while you were working. Reload the page to see their changes, then try again.',
  CSRF_FAILED: 'Your session security token is out of date. Reload the page and try again.',
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
  const body = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string };
  const code = body.code ?? null;
  return new ApiError((code && FRIENDLY[code]) || body.error || `HTTP ${status}`, status, code);
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
