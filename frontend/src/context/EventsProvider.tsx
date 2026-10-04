import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { AppEvent, MessageSummary } from '../lib/types';
import { EventsContext, type EventHandler, type EventsContextValue, type LiveStatus } from './events';
import { useToast } from './toast';

export const BASE_TITLE = 'Private Mail Testing';
const EVENT_TYPES = ['EMAIL_RECEIVED', 'MAILBOX_CREATED', 'MAILBOX_DELETED', 'MESSAGE_DELETED', 'MESSAGES_CLEARED'] as const;

function parseEvent(raw: string): AppEvent | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string') {
      return data as AppEvent;
    }
  } catch {
    /* ignore malformed frames */
  }
  return null;
}

/** One app-level SSE connection (mounted only while signed in), shared by every view. */
export function EventsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [unread, setUnread] = useState<number | null>(null);
  const handlers = useRef(new Set<EventHandler>());
  const refreshTimer = useRef<number | undefined>(undefined);
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const loadUnread = useCallback(() => {
    api
      .get<MessageSummary[]>('/messages', { filter: 'unread', pageSize: 1 })
      .then(({ meta }) => {
        if (meta) setUnread(meta.total);
      })
      .catch(() => undefined);
  }, []);

  const refreshUnread = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(loadUnread, 400);
  }, [loadUnread]);

  const subscribe = useCallback((handler: EventHandler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    loadUnread();
    return () => window.clearTimeout(refreshTimer.current);
  }, [loadUnread]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let hadError = false;
    let attempt = 0;
    let disposed = false;

    const dispatch = (event: AppEvent) => {
      for (const h of [...handlers.current]) {
        try {
          h(event);
        } catch (err) {
          console.error('event handler failed', err);
        }
      }
    };

    const handle = (raw: string) => {
      const event = parseEvent(raw);
      if (!event) return;
      if (event.type === 'EMAIL_RECEIVED') {
        setUnread((n) => (n ?? 0) + 1);
        toastRef.current.push({
          message: `New email from ${event.from}: ${event.subject || '(no subject)'}`,
          href: `/messages/${event.messageId}`,
          linkLabel: 'Open',
        });
      } else {
        loadUnread();
      }
      dispatch(event);
    };

    const connect = () => {
      if (disposed) return;
      const es = new EventSource('/api/events');
      source = es;
      es.onopen = () => {
        attempt = 0;
        setStatus('live');
        if (hadError) {
          hadError = false;
          loadUnread();
          dispatch({ type: 'RECONNECTED' });
        }
      };
      es.onerror = () => {
        hadError = true;
        setStatus('reconnecting');
        // EventSource retries by itself unless the server answered with an error status (e.g. 401/503).
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          attempt += 1;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
          retryTimer = window.setTimeout(() => {
            // A 401 here drops the session through the shared unauthorised handler.
            api
              .get('/auth/me')
              .then(connect, () => connect());
          }, delay);
        }
      };
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (e) => handle((e as MessageEvent<string>).data));
      }
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [loadUnread]);

  // Reflect the unread count in the tab title: "(3) Private Mail Testing".
  useEffect(() => {
    document.title = unread && unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unread]);
  useEffect(() => () => void (document.title = BASE_TITLE), []);

  const value = useMemo<EventsContextValue>(
    () => ({ status, unread, refreshUnread, subscribe }),
    [status, unread, refreshUnread, subscribe],
  );
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}
