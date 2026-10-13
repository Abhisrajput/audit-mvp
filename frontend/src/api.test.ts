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

  it('shows the request id of an unexpected server error so it can be reported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { code: 'INTERNAL', requestId: 'req-12345678' })));
    await expect(api('/x')).rejects.toMatchObject({
      status: 500, code: 'INTERNAL', requestId: 'req-12345678', message: expect.stringContaining('req-12345678'),
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

  it('explains agent and gate errors in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'The workpaper changed after this gate opened', code: 'GATE_STALE' })));
    await expect(api('/gates/G-1/sign-intents', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'GATE_STALE', message: expect.stringMatching(/opens a new gate/) });
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'Agent runs are switched off (AGENT_ENABLED=false)', code: 'AGENT_DISABLED' })));
    await expect(api('/engagements/E-1/runs', { method: 'POST', body: {} })).rejects.toMatchObject({ message: expect.stringMatching(/switched off on this server/) });
  });
});
