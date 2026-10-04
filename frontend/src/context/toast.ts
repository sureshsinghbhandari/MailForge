import { createContext, useContext } from 'react';

export interface ToastInput {
  message: string;
  kind?: 'info' | 'success' | 'error';
  /** Optional in-app link shown inside the toast. */
  href?: string;
  linkLabel?: string;
  durationMs?: number;
}

export interface ToastContextValue {
  push: (toast: ToastInput) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
