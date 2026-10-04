import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { ApiError } from '../lib/api';

interface Settled<T> {
  requestKey: string;
  data: T | undefined;
  error: ApiError | Error | null;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: Error | null;
  /** True while a request for the current key is in flight (previous data stays available). */
  loading: boolean;
  /** True only until the very first response arrives. */
  initialLoading: boolean;
  /** Refetch; keeps showing the previous data meanwhile. */
  reload: () => void;
  /** Locally patch the cached data (e.g. after a mutation). */
  setData: (updater: (prev: T) => T) => void;
}

/**
 * Minimal data-fetching hook. `key` identifies the request (change it to refetch; `null` disables).
 * The fetcher may change every render; the latest one is used. Stale responses are discarded.
 */
export function useQuery<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): QueryResult<T> {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const run = useEffectEvent((signal: AbortSignal) => fetcher(signal));

  const requestKey = key === null ? null : `${key}#${nonce}`;

  useEffect(() => {
    if (requestKey === null) return;
    const controller = new AbortController();
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ requestKey, data, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setSettled((prev) => ({ requestKey, data: prev?.data, error: err }));
      },
    );
    return () => controller.abort();
  }, [requestKey]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: (prev: T) => T) => {
    setSettled((prev) => (prev && prev.data !== undefined ? { ...prev, data: updater(prev.data) } : prev));
  }, []);

  const loading = requestKey !== null && settled?.requestKey !== requestKey;
  return {
    data: settled?.data,
    error: loading ? null : (settled?.error ?? null),
    loading,
    initialLoading: loading && settled?.data === undefined,
    reload,
    setData,
  };
}
