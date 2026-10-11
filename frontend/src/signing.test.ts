import { describe, expect, it } from 'vitest';
import { signWithReauth, type SigningDeps } from './signing';

/** Fake browser: the intent call returns `intent`, then each status poll returns the next queued status. */
function fakeDeps(statuses: { status: string; code?: string | null; message?: string | null }[], popup: { closed: boolean } | null = { closed: false }) {
  const calls: string[] = [];
  let t = 0;
  const deps: SigningDeps = {
    api: (async (path: string) => {
      calls.push(path);
      if (path.endsWith('/sign-intents')) {
        return { intentId: 'INT-1', reauthUrl: '/auth/sign/INT-1', method: 'dev', expiresAt: new Date(10 * 60_000).toISOString() };
      }
      const next = statuses.shift() ?? { status: 'pending' };
      return { code: null, message: null, ...next };
    }) as SigningDeps['api'],
    openPopup: () => popup,
    sleep: async () => {
      t += 1000;
    },
    now: () => t,
  };
  return { deps, calls };
}

describe('signWithReauth', () => {
  it('opens the re-authentication window and resolves once the signature is recorded', async () => {
    const { deps, calls } = fakeDeps([{ status: 'pending' }, { status: 'claimed' }, { status: 'signed' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', 'ok', deps)).resolves.toBeUndefined();
    expect(calls[0]).toBe('/engagements/ENG-1/findings/F-1/sign-intents');
    expect(calls.filter((c) => c === '/sign-intents/INT-1')).toHaveLength(3);
  });

  it('explains a finding that changed while signing', async () => {
    const { deps } = fakeDeps([{ status: 'failed', code: 'CONTENT_CHANGED', message: 'server text' }]);
    await expect(signWithReauth('ENG-1', 'F-1', 'approve', '', deps)).rejects.toMatchObject({
      code: 'CONTENT_CHANGED', message: expect.stringMatching(/changed after you started signing/),
    });
  });

  it('asks for pop-ups to be allowed when the window is blocked', async () => {
    const { deps } = fakeDeps([], null);
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
  });

  it('stops when the window is closed before re-authentication finishes, leaving nothing signed', async () => {
    const popup = { closed: false };
    const { deps } = fakeDeps([{ status: 'pending' }]);
    const sleeping = deps.sleep;
    deps.sleep = async (ms) => {
      popup.closed = true;
      await sleeping(ms);
    };
    deps.openPopup = () => popup;
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'POPUP_CLOSED' });
  });

  it('gives up when the signing request expires', async () => {
    const { deps } = fakeDeps([]);
    deps.now = () => 11 * 60_000;
    await expect(signWithReauth('ENG-1', 'F-1', 'review', '', deps)).rejects.toMatchObject({ code: 'INTENT_EXPIRED' });
  });
});
