import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ToastContext, type ToastContextValue, type ToastInput } from './toast';

interface ToastItem extends ToastInput {
  id: number;
}

const MAX_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { ...toast, id }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), toast.durationMs ?? 6000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const t of active.values()) window.clearTimeout(t);
      active.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Always mounted so screen readers register the live region before the first toast. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid="toast"
            className={`toast pointer-events-auto w-full max-w-sm ${t.kind === 'error' ? 'toast-error' : t.kind === 'success' ? 'toast-success' : ''}`}
          >
            <p className="min-w-0 flex-1 break-words text-sm">{t.message}</p>
            {t.href ? (
              <Link to={t.href} onClick={() => dismiss(t.id)} className="link shrink-0 text-sm font-medium">
                {t.linkLabel ?? 'Open'}
              </Link>
            ) : null}
            <button type="button" className="icon-btn -mr-1 shrink-0" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
