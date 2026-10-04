import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
      <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span>{label}…</span>
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorBanner({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  const message = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="banner banner-error">
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <p className="break-words">{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm shrink-0" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, children, subtitle }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-base font-medium">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{children}</div> : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: 'healthy' | 'unhealthy' | 'active' | 'expired' }) {
  const good = status === 'healthy' || status === 'active';
  return (
    <span className={`badge ${good ? 'badge-green' : 'badge-red'}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${good ? 'bg-emerald-500' : 'bg-red-500'}`} />
      {status === 'healthy' ? 'Healthy' : status === 'unhealthy' ? 'Unhealthy' : status === 'active' ? 'Active' : 'Expired'}
    </span>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  noun = 'items',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <p className="text-slate-500 dark:text-slate-400">
        {total === 0 ? `No ${noun}` : `${from}-${to} of ${total} ${noun}`}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="text-slate-500 dark:text-slate-400">
          Page {page} of {pages}
        </span>
        <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}
