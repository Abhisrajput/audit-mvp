import { describe, expect, it } from 'vitest';
import { signWithReauth, type SigningDeps, type SigningWindow } from './signing';

type Status = { status: string; code?: string | null; message?: string | null };

/**
 * Fake browser. The intent call returns a request expiring at 10 min (fake clock); each status poll takes the
 * next queued entry (an Error entry makes that poll fail); a cancel is recorded and moves the queue on only if asked.
 */
function fakeDeps(statuses: (Status | Error)[], opts: { intentError?: Error } = {}) {
  const calls: string[] = [];
  const navigated: string[] = [];
  const closed: SigningWindow[] = [];
  let t = 0;
  const deps: SigningDeps = {
    api: (async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/sign-intents')) {
        if (opts.intentError) throw opts.intentError;
        return { intentId: 'INT-1', reauthUrl: '/auth/sign/INT-1', method: 'dev', expiresAt: new Date(10 * 60_000).toISOString() };
      }
      if (path.endsWith('/cancel')) return { status: 'failed', code: 'REAUTH_REQUIRED', message: 'Cancelled before re-authentication finished' };
      const next = statuses.shift() ?? { status: 'pending' };
      if (next instanceof Error) throw next;
      return { code: null, message: null, ...next };
    }) as SigningDeps['api'],
    openPopup: () => ({ closed: false }),
    navigate: (_popup, url) => {
      navigated.push(url);
    },
    closePopup: (popup) => {
      closed.push(popup);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, navigated, closed, setNow: (ms: number) => (t = ms) };
}

const polls = (calls: string[]) => calls.filter((c) => c === 'GET /sign-intents/INT-1').length;

describe('signWithReauth', () => {
  it('sends the already-open window to the re-authentication page and resolves once the signature is recorded', async () => {
    const { deps, calls, navigated } = fakeDeps([{ status: 'pending' }, { status: 'claimed' }, { status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', 'ok', { closed: false }, { deps })).resolves.toBeUndefined();
    expect(calls[0]).toBe('POST /engagements/ENG-1/findings/F-1/sign-intents');
    expect(navigated).toEqual(['/auth/sign/INT-1']);
    expect(polls(calls)).toBe(3);
  });

  it('explains a finding that changed while signing', async () => {
    const { deps } = fakeDeps([{ status: 'failed', code: 'CONTENT_CHANGED', message: 'server text' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'approve', '', { closed: false }, { deps })).rejects.toMatchObject({
      code: 'CONTENT_CHANGED', message: expect.stringMatching(/changed after you started signing/),
    });
  });

  it("shows the server's reason for a stale re-authentication, and a plain message for a different person", async () => {
    const stale = fakeDeps([{ status: 'failed', code: 'REAUTH_STALE', message: 'Your identity provider reused an earlier sign-in instead of asking for your password.' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'approve', '', { closed: false }, { deps: stale.deps })).rejects.toMatchObject({
      code: 'REAUTH_STALE', message: expect.stringMatching(/reused an earlier sign-in/),
    });
    const other = fakeDeps([{ status: 'failed', code: 'REAUTH_USER_MISMATCH', message: 'server text' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'approve', '', { closed: false }, { deps: other.deps })).rejects.toMatchObject({
      code: 'REAUTH_USER_MISMATCH', message: expect.stringMatching(/different person/),
    });
  });

  it('asks for pop-ups to be allowed when the window is blocked, before creating a signing request', async () => {
    const { deps, calls } = fakeDeps([]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', null, { deps })).rejects.toMatchObject({ code: 'POPUP_BLOCKED', message: expect.stringMatching(/Allow pop-ups/) });
    expect(calls).toEqual([]);
  });

  it('closes the window when the signing request cannot be made', async () => {
    const popup = { closed: false };
    const { deps, closed, navigated } = fakeDeps([], { intentError: new Error('You prepared this finding') });
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', popup, { deps })).rejects.toThrow(/prepared/);
    expect(closed).toEqual([popup]);
    expect(navigated).toEqual([]);
  });

  it('keeps waiting while the window reports closed, since identity-provider pages can hide it', async () => {
    const popup = { closed: true };
    const { deps, calls } = fakeDeps([{ status: 'pending' }, { status: 'claimed' }, { status: 'claimed' }, { status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', popup, { deps })).resolves.toBeUndefined();
    expect(polls(calls)).toBe(4);
    expect(calls.some((c) => c.endsWith('/cancel'))).toBe(false);
  });

  it('retries a failed status check, then carries on', async () => {
    const { deps } = fakeDeps([new Error('offline'), new Error('offline'), { status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps })).resolves.toBeUndefined();
  });

  it('gives up after repeated failed status checks without claiming nothing was signed', async () => {
    const { deps } = fakeDeps([new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline')]);
    const err = await signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps }).catch((e) => e);
    expect(err).toMatchObject({ code: 'LOST_CONTACT', message: 'Lost contact while signing. Reload to see whether your signature was recorded.' });
  });

  it('cancels the request when the signer cancels, and says nothing was signed once the server confirms', async () => {
    const controller = new AbortController();
    const { deps, calls } = fakeDeps([{ status: 'pending' }, { status: 'failed', code: 'REAUTH_REQUIRED', message: 'Cancelled before re-authentication finished' }]);
    const sleeping = deps.sleep;
    deps.sleep = async (ms) => {
      await sleeping(ms);
      if (polls(calls) === 1) controller.abort();
    };
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED', message: expect.stringMatching(/Nothing was signed/),
    });
    expect(calls).toContain('POST /sign-intents/INT-1/cancel');
    expect(calls.at(-1)).toBe('GET /sign-intents/INT-1');
  });

  it('accepts a signature that landed just as the signer cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = fakeDeps([{ status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps, signal: controller.signal })).resolves.toBeUndefined();
  });

  it('checks once more at the deadline and accepts a signature recorded in time', async () => {
    const { deps, calls, setNow } = fakeDeps([{ status: 'signed' }]);
    setNow(11 * 60_000);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps })).resolves.toBeUndefined();
    expect(calls).toContain('POST /sign-intents/INT-1/cancel');
  });

  it('gives up when the signing request expires, saying nothing was signed once the server confirms', async () => {
    const { deps, setNow } = fakeDeps([{ status: 'failed', code: 'REAUTH_REQUIRED', message: 'Cancelled before re-authentication finished' }]);
    setNow(11 * 60_000);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', { closed: false }, { deps })).rejects.toMatchObject({
      code: 'INTENT_EXPIRED', message: expect.stringMatching(/expired.*Nothing was signed/),
    });
  });
});
