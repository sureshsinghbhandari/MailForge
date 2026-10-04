import { createContext, useContext, useEffect, useEffectEvent } from 'react';
import type { AppEvent } from '../lib/types';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';
export type EventHandler = (event: AppEvent) => void;

export interface EventsContextValue {
  status: LiveStatus;
  /** App-wide count of unread messages (null until first loaded). */
  unread: number | null;
  /** Re-read the unread count from the server (debounced). */
  refreshUnread: () => void;
  subscribe: (handler: EventHandler) => () => void;
}

export const EventsContext = createContext<EventsContextValue | null>(null);

export function useEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside <EventsProvider>');
  return ctx;
}

/** Subscribes the calling component to live server events for as long as it is mounted. */
export function useAppEvents(handler: EventHandler): void {
  const { subscribe } = useEvents();
  const onEvent = useEffectEvent(handler);
  useEffect(() => subscribe((event) => onEvent(event)), [subscribe]);
}
