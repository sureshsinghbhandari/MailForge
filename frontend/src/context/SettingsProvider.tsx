import { useMemo, type ReactNode } from 'react';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import type { SystemStatus } from '../lib/types';
import { SettingsContext, type SettingsContextValue } from './settings';

/** Loads the non-secret runtime settings once (from /api/system/status) for the whole signed-in app. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const q = useQuery('settings', async (signal) => (await api.get<SystemStatus>('/system/status', undefined, { signal })).data.settings);
  const { data: settings, error, reload } = q;
  const value = useMemo<SettingsContextValue>(() => ({ settings, error, reload }), [settings, error, reload]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
