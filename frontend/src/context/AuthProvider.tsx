import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from '../lib/api';
import type { LoginResponse, MeResponse } from '../lib/types';
import { AuthContext, type AuthContextValue, type AuthState } from './auth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // Any 401 from a normal API call means the session is gone: drop auth state (routes redirect to /login).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setState((prev) => (prev.status === 'anonymous' ? prev : { status: 'anonymous' }));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/auth/me', undefined, { skipUnauthorizedHandler: true })
      .then(({ data }) => {
        if (cancelled) return;
        setCsrfToken(data.csrfToken);
        setState({ status: 'authenticated', user: data.user });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'anonymous' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await api.post<LoginResponse>('/auth/login', { email, password }, { skipUnauthorizedHandler: true });
    setCsrfToken(data.csrfToken);
    setState({ status: 'authenticated', user: data.user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, { skipUnauthorizedHandler: true });
    } catch {
      /* the session is dropped locally regardless */
    }
    setCsrfToken(null);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
