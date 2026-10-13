import { api } from './api';

export class SigningError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'SigningError';
  }
}

/** The re-authentication window. Only `closed` is read, and it is not trusted (see below). */
export interface SigningWindow {
  readonly closed: boolean;
}

export interface SigningDeps {
  api: typeof api;
  /** Must be called synchronously from the click, or the browser blocks the window. */
  openPopup: (url: string, name: string) => SigningWindow | null;
  navigate: (popup: SigningWindow, url: string) => void;
  closePopup: (popup: SigningWindow) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface Intent {
  intentId: string;
  reauthUrl: string;
  method: 'oidc' | 'dev';
  expiresAt: string;
}

interface IntentStatus {
  status: 'pending' | 'claimed' | 'signed' | 'failed';
  code: string | null;
  message: string | null;
}

const MESSAGES: Record<string, string> = {
  REAUTH_STALE: 'Your identity provider did not ask for your password for this signature. Try again and enter your password when asked.',
  REAUTH_USER_MISMATCH: 'You re-authenticated as a different person. Sign with the account you are signed in with.',
  INTENT_EXPIRED: 'The signing request expired. Start signing again.',
  REAUTH_REQUIRED: 'Re-authentication did not complete. Try again.',
  CANCELLED: 'Signing was cancelled. Nothing was signed.',
};
/** Codes whose server message names the specific cause, so it is shown when present. */
const SERVER_EXPLAINS = new Set(['REAUTH_STALE', 'REAUTH_REQUIRED']);
const LOST_CONTACT = 'Lost contact while signing. Reload to see whether your signature was recorded.';
const POLL_MS = 1000;
const MAX_RETRIES = 3;

/** What is being signed, so a message can name it. */
type Subject = 'finding' | 'workpaper';

export const browserSigning: SigningDeps = {
  api,
  openPopup: (url, name) => window.open(url, name, 'popup,width=520,height=640'),
  navigate: (popup, url) => {
    (popup as Window).location.href = url;
  },
  closePopup: (popup) => (popup as Window).close(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Opens an empty signing window. Call it first thing in the click handler, before any await. */
export function openSigningWindow(deps: SigningDeps = browserSigning): SigningWindow | null {
  return deps.openPopup('about:blank', `audit-sign-${Date.now()}`);
}

/** REAUTH_STALE and REAUTH_REQUIRED have several causes, and the server names the one that happened. */
function explain(s: IntentStatus, subject: Subject): SigningError {
  if (s.code === 'CONTENT_CHANGED') return new SigningError(`The ${subject} changed after you started signing. Review it again, then sign.`, s.code);
  const text = s.code && SERVER_EXPLAINS.has(s.code) ? s.message || MESSAGES[s.code] : (s.code && MESSAGES[s.code]) || s.message || 'Signing failed.';
  return new SigningError(text, s.code);
}

/**
 * The Part 11 signing loop, whatever is being signed. The caller has already opened `popup`
 * (synchronously, from the click). `start` asks the server for a signing request; the window is sent to
 * re-authenticate; then the request is followed until it is signed or fails.
 *
 * The window's `closed` flag is not used: identity-provider pages with Cross-Origin-Opener-Policy
 * report the window closed while the signer is still typing their password. Waiting ends when the
 * server says signed or failed, when the request runs out, or when `signal` aborts (the Cancel button).
 * On giving up, the request is cancelled on the server and its final state read back, so a
 * signature that landed at the last moment is still reported as signed.
 */
async function followSigning(
  start: () => Promise<Intent>,
  subject: Subject,
  popup: SigningWindow | null,
  { signal, deps }: { signal?: AbortSignal; deps: SigningDeps },
): Promise<void> {
  if (!popup) throw new SigningError('Your browser blocked the sign-in window. Allow pop-ups for this site, then sign again.', 'POPUP_BLOCKED');
  let intent: Intent;
  try {
    intent = await start();
    deps.navigate(popup, intent.reauthUrl);
  } catch (err) {
    deps.closePopup(popup);
    throw err;
  }

  const status = () => deps.api<IntentStatus>(`/sign-intents/${intent.intentId}`);
  const deadline = Date.parse(intent.expiresAt);
  let failures = 0;
  while (!signal?.aborted && deps.now() <= deadline) {
    await deps.sleep(failures ? POLL_MS * 2 ** failures : POLL_MS);
    if (signal?.aborted) break;
    let s: IntentStatus;
    try {
      s = await status();
      failures = 0;
    } catch {
      if (++failures > MAX_RETRIES) throw new SigningError(LOST_CONTACT, 'LOST_CONTACT');
      continue;
    }
    if (s.status === 'signed') return;
    if (s.status === 'failed') throw explain(s, subject);
  }

  // Cancelled or out of time: cancel on the server, then believe only what it says.
  const cancelled = !!signal?.aborted;
  try {
    await deps.api(`/sign-intents/${intent.intentId}/cancel`, { method: 'POST', body: cancelled ? {} : { reason: 'expired' } });
  } catch {
    // The status read below decides.
  }
  let final: IntentStatus;
  try {
    final = await status();
  } catch {
    throw new SigningError(LOST_CONTACT, 'LOST_CONTACT');
  }
  if (final.status === 'signed') return;
  if (!popup.closed) deps.closePopup(popup);
  if (final.status === 'failed') {
    if (final.code === 'CANCELLED') throw new SigningError('Signing cancelled. Nothing was signed.', 'CANCELLED');
    if (final.code === 'INTENT_EXPIRED') throw new SigningError('The signing request expired. Nothing was signed. Start signing again.', 'INTENT_EXPIRED');
    throw explain(final, subject);
  }
  // Still being completed on the server: we cannot say either way.
  throw new SigningError('Your signature is still being processed. Reload to see whether it was recorded.', 'UNCONFIRMED');
}

/** Signs a finding as a Part 11 electronic signature (review, approve or reject). */
export function signWithReauth(
  engagementId: string,
  findingId: string,
  action: 'review' | 'approve' | 'reject',
  comment: string,
  popup: SigningWindow | null,
  { signal, deps = browserSigning }: { signal?: AbortSignal; deps?: SigningDeps } = {},
): Promise<void> {
  const start = () => deps.api<Intent>(`/engagements/${engagementId}/findings/${findingId}/sign-intents`, { method: 'POST', body: { action, comment } });
  return followSigning(start, 'finding', popup, { signal, deps });
}

/**
 * Signs a scope, RCM or report gate the agent opened (agent spec section 4.3), through the same window and request.
 * A rejection needs a comment: the agent redrafts the workpaper from it.
 */
export function signGateWithReauth(
  gateId: string,
  action: 'approve' | 'reject',
  comment: string,
  popup: SigningWindow | null,
  { signal, deps = browserSigning }: { signal?: AbortSignal; deps?: SigningDeps } = {},
): Promise<void> {
  const start = () => deps.api<Intent>(`/gates/${gateId}/sign-intents`, { method: 'POST', body: { action, comment } });
  return followSigning(start, 'workpaper', popup, { signal, deps });
}
