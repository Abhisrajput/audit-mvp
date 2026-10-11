import { api } from './api';

export class SigningError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'SigningError';
  }
}

export interface SigningDeps {
  api: typeof api;
  openPopup: (url: string) => { closed: boolean } | null;
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
  REAUTH_STALE: 'Your identity provider did not ask for your password just now. Try again and enter your password when asked.',
  REAUTH_USER_MISMATCH: 'You re-authenticated as a different person. Sign with the account you are signed in with.',
  INTENT_EXPIRED: 'The signing request expired. Start signing again.',
  CONTENT_CHANGED: 'The finding changed after you started signing. Review it again, then sign.',
  REAUTH_REQUIRED: 'Re-authentication did not complete. Try again.',
};

const browser: SigningDeps = {
  api,
  openPopup: (url) => window.open(url, 'audit-sign', 'popup,width=520,height=640'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Signs a finding as a Part 11 electronic signature. It asks the server for a signing request,
 * opens the re-authentication window, then follows the request until it is signed or fails.
 */
export async function signWithReauth(
  engagementId: string,
  findingId: string,
  action: 'review' | 'approve' | 'reject',
  comment: string,
  deps: SigningDeps = browser,
): Promise<void> {
  const intent = await deps.api<Intent>(`/engagements/${engagementId}/findings/${findingId}/sign-intents`, { method: 'POST', body: { action, comment } });
  const popup = deps.openPopup(intent.reauthUrl);
  if (!popup) throw new SigningError('Your browser blocked the sign-in window. Allow pop-ups for this site, then sign again.', 'POPUP_BLOCKED');
  const deadline = Date.parse(intent.expiresAt);
  for (;;) {
    await deps.sleep(1000);
    const s = await deps.api<IntentStatus>(`/sign-intents/${intent.intentId}`);
    if (s.status === 'signed') return;
    if (s.status === 'failed') throw new SigningError((s.code && MESSAGES[s.code]) || s.message || 'Signing failed.', s.code);
    if (s.status === 'pending' && popup.closed) throw new SigningError('The sign-in window was closed before you finished. Nothing was signed.', 'POPUP_CLOSED');
    if (deps.now() > deadline) throw new SigningError(MESSAGES.INTENT_EXPIRED, 'INTENT_EXPIRED');
  }
}
