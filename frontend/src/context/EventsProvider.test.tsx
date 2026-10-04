import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../lib/api';
import type { AppEvent } from '../lib/types';
import { EventsProvider } from './EventsProvider';
import { ToastProvider } from './ToastProvider';
import { useAppEvents, useEvents } from './events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function Probe({ onEvent }: { onEvent: (e: AppEvent) => void }) {
  const { status, unread } = useEvents();
  useAppEvents(onEvent);
  return (
    <p>
      {status}|{unread ?? 'none'}
    </p>
  );
}

describe('EventsProvider', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ success: true, data: [], meta: { page: 1, pageSize: 1, total: 2 } }), { status: 200 })),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('opens one stream, tracks live status, bumps unread + title, toasts and notifies subscribers', async () => {
    const onEvent = vi.fn();
    render(
      <MemoryRouter>
        <ToastProvider>
          <EventsProvider>
            <Probe onEvent={onEvent} />
          </EventsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    expect(es.url).toBe('/api/events');
    expect(await screen.findByText('connecting|2')).toBeInTheDocument();

    act(() => es.onopen?.());
    expect(screen.getByText('live|2')).toBeInTheDocument();
    expect(document.title).toBe('(2) Private Mail Testing');

    const event = { type: 'EMAIL_RECEIVED', mailboxId: 'mb', messageId: 'm1', from: 'a@b.c', subject: 'Your code', receivedAt: '2026-01-01T00:00:00Z' };
    act(() => es.emit('EMAIL_RECEIVED', event));
    expect(screen.getByText('live|3')).toBeInTheDocument();
    expect(document.title).toBe('(3) Private Mail Testing');
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(screen.getByRole('status')).toHaveTextContent('New email from a@b.c: Your code');

    act(() => es.onerror?.());
    expect(screen.getByText('reconnecting|3')).toBeInTheDocument();
    act(() => es.onopen?.());
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'RECONNECTED' });
  });

  it('ignores malformed frames and closes the stream on unmount', () => {
    const onEvent = vi.fn();
    const { unmount } = render(
      <MemoryRouter>
        <ToastProvider>
          <EventsProvider>
            <Probe onEvent={onEvent} />
          </EventsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      for (const fn of es.listeners.get('EMAIL_RECEIVED') ?? []) fn({ data: 'not json' } as MessageEvent<string>);
    });
    expect(onEvent).not.toHaveBeenCalled();
    unmount();
    expect(es.closed).toBe(true);
    expect(document.title).toBe('Private Mail Testing');
  });
});
