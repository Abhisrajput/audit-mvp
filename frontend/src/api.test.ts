import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, requestInit, setCsrfToken, setUnauthenticatedHandler } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setCsrfToken(null);
  setUnauthenticatedHandler(() => undefined);
  vi.unstubAllGlobals();
});

describe('requestInit', () => {
  it('sends the CSRF token on changes, never on reads', () => {
    setCsrfToken('tok');
    expect((requestInit({ method: 'POST', body: {} }).headers as Record<string, string>)['x-csrf-token']).toBe('tok');
    expect((requestInit({}).headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect(requestInit({}).credentials).toBe('same-origin');
  });

  it('sends the engagement version as a quoted If-Match', () => {
    expect((requestInit({ method: 'PUT', ifMatch: 7 }).headers as Record<string, string>)['If-Match']).toBe('"7"');
    expect((requestInit({ method: 'PUT' }).headers as Record<string, string>)['If-Match']).toBeUndefined();
  });
});

describe('api errors', () => {
  it('turns a version conflict into a plain "reload" message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'Engagement ENG-1 is at version 4, not 3', code: 'VERSION_CONFLICT' })));
    await expect(api('/engagements/ENG-1/scope', { method: 'PUT', body: {}, ifMatch: 3 })).rejects.toMatchObject({
      status: 409, code: 'VERSION_CONFLICT', message: expect.stringMatching(/Someone else changed this engagement.*Reload/),
    });
  });

  it("keeps the server's own message for other errors", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: 'You prepared this finding, so someone else must review it', code: 'SOD_VIOLATION' })));
    await expect(api('/x', { method: 'POST' })).rejects.toMatchObject({ code: 'SOD_VIOLATION', message: 'You prepared this finding, so someone else must review it' });
  });

  it('tells the app when the session has ended', async () => {
    const signedOut = vi.fn();
    setUnauthenticatedHandler(signedOut);
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Sign in to continue', code: 'UNAUTHENTICATED' })));
    await expect(api('/engagements')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledOnce();
  });
});
