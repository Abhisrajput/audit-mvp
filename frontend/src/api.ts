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
  TOLERANCE_LOCKED: 'A test has been recorded for this control, so its tolerance can no longer change. Record the reason in the finding instead.',
  FINDING_NOT_APPROVED: 'Management responses can be recorded once the finding is approved. Approve the finding first.',
  RESPONSE_LOCKED: 'The report is approved, so management responses can no longer be added. Start a new engagement for later matters.',
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

/** Headers for a multipart upload: the CSRF token, and no Content-Type (the browser sets the multipart boundary). */
export function uploadHeaders(): Record<string, string> {
  return csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

/** POST a file and text fields as multipart/form-data, reporting progress as a 0..1 fraction. */
export function upload<T>(path: string, file: File, fields: Record<string, string>, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(uploadHeaders())) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0 && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError('The upload could not reach the server. Check your connection and try again.', 0, null));
    xhr.onabort = () => reject(new ApiError('The upload was cancelled.', 0, null));
    xhr.onload = () => {
      let data: unknown = xhr.responseText;
      let parsed = false;
      if (xhr.responseText && (xhr.getResponseHeader('content-type') ?? '').includes('json')) {
        try {
          data = JSON.parse(xhr.responseText);
          parsed = true;
        } catch {
          data = {};
        }
      }
      if (xhr.status === 401) onUnauthenticated();
      if (xhr.status < 200 || xhr.status >= 300) return reject(errorFrom(xhr.status, data));
      if (!parsed) return reject(new ApiError('Unexpected response from the server.', xhr.status, null));
      onProgress?.(1);
      resolve(data as T);
    };
    const form = new FormData();
    // Text fields first so the server sees them before the file part.
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', file);
    xhr.send(form);
  });
}
