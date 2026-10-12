import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, request, setCsrfToken, setUnauthenticatedHandler } from './api';
import type { Role, User } from './types';

export interface Me {
  user: { id: string; name: string; email: string | null; role: Role | null };
  csrfToken: string;
  pendingAccess: boolean;
}

export interface SignInOptions {
  devAuth: boolean;
  oidc: boolean;
}

export type SessionStatus = 'loading' | 'signed-out' | 'pending' | 'ready';

interface Session {
  status: SessionStatus;
  /** The signed-in user, once they have a role. */
  user: User | null;
  me: Me | null;
  options: SignInOptions | null;
  provider: { id: string; model: string } | null;
  error: string | null;
  devLogin: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [provider, setProvider] = useState<Session['provider']>(null);
  const [error, setError] = useState<string | null>(null);

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    setMe(null);
    setStatus('signed-out');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/me');
      setCsrfToken(m.csrfToken);
      setMe(m);
      setError(null);
      setStatus(m.pendingAccess ? 'pending' : 'ready');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : String(e));
      signedOut();
    }
  }, [signedOut]);

  useEffect(() => {
    setUnauthenticatedHandler(signedOut);
    request<SignInOptions>('/auth/config').then(setOptions, () => setOptions({ devAuth: false, oidc: false }));
    api<{ provider: Session['provider'] }>('/health').then((h) => setProvider(h.provider), () => undefined);
    refresh();
  }, [refresh, signedOut]);

  const devLogin = async (userId: string) => {
    await request('/auth/dev-login', { method: 'POST', body: { userId } });
    await refresh();
  };

  /** Signs out locally only once the server has ended the session (401: it already had). Otherwise rethrows. */
  const logout = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    signedOut();
  };

  const user: User | null = me?.user.role ? { id: me.user.id, name: me.user.name, role: me.user.role } : null;
  return <Ctx.Provider value={{ status, user, me, options, provider, error, devLogin, logout }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const session = useContext(Ctx);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
