import { useEffect } from 'react';
import { ErrorBanner, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import { formatUptime } from '../lib/format';
import type { ServiceStatus, SystemStatus } from '../lib/types';
import { CleanupResultView } from './SettingsPage';

const POLL_MS = 15_000;

function ServiceCard({ name, description, status }: { name: string; description: string; status: ServiceStatus | undefined }) {
  return (
    <div className="card p-4" data-testid={`service-${name.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{name}</h2>
        {status ? <StatusBadge status={status} /> : <Skeleton className="h-5 w-16" />}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

export function StatusPage() {
  const q = useQuery('system-status', async (signal) => (await api.get<SystemStatus>('/system/status', undefined, { signal })).data);
  const { reload } = q;

  useEffect(() => {
    const id = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const s = q.data;
  return (
    <div>
      <PageHeader title="System Status" subtitle="Refreshes every 15 seconds.">
        <button type="button" className="btn" onClick={reload} disabled={q.loading}>
          Refresh
        </button>
      </PageHeader>

      {q.error ? (
        <div className="mb-4">
          <ErrorBanner error={q.error} title="Could not read system status" onRetry={reload} />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <ServiceCard name="Application" description="The MailForge API server." status={s ? 'healthy' : undefined} />
        <ServiceCard name="Database" description="PostgreSQL connection." status={s?.database} />
        <ServiceCard name="SMTP capture" description={s ? `${s.settings.smtpHost}:${s.settings.smtpPort}` : 'Mail capture service.'} status={s?.smtp} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <section className="card p-4" aria-labelledby="runtime-h">
          <h2 id="runtime-h" className="mb-3 text-sm font-semibold">
            Runtime
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-500 dark:text-slate-400">Version</dt>
            <dd className="font-mono">{s?.version ?? '-'}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Uptime</dt>
            <dd>{s ? formatUptime(s.uptimeSeconds) : '-'}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Environment</dt>
            <dd>{s?.settings.environment ?? '-'}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Overall</dt>
            <dd>{s ? <StatusBadge status={s.status} /> : '-'}</dd>
          </dl>
        </section>
        <section className="card p-4" aria-labelledby="cleanup-h">
          <h2 id="cleanup-h" className="mb-3 text-sm font-semibold">
            Last cleanup
          </h2>
          {s ? (
            s.lastCleanup ? (
              <CleanupResultView result={s.lastCleanup} />
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">No cleanup has run since the server started.</p>
            )
          ) : (
            <Skeleton className="h-16" />
          )}
        </section>
      </div>
    </div>
  );
}
