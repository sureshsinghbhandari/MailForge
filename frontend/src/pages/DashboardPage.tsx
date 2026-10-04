import { Link } from 'react-router-dom';
import { MessageTable } from '../components/MessageTable';
import { SendSnippet } from '../components/SendSnippet';
import { EmptyState, ErrorBanner, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { useAppEvents } from '../context/events';
import { useSettings } from '../context/settings';
import { useNow } from '../hooks/useNow';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import type { DashboardData, Mailbox } from '../lib/types';

function Stat({ label, value, hint, testId }: { label: string; value: number | undefined; hint?: string; testId: string }) {
  return (
    <div className="card p-4" data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      {value === undefined ? <Skeleton className="mt-2 h-8 w-16" /> : <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>}
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function DashboardPage() {
  const dash = useQuery('dashboard', async (signal) => (await api.get<DashboardData>('/dashboard', undefined, { signal })).data);
  const { settings } = useSettings();
  const firstMailbox = useQuery('dashboard-first-mailbox', async (signal) => (await api.get<Mailbox[]>('/mailboxes', { status: 'active', pageSize: 1 }, { signal })).data[0]?.email ?? null);
  const now = useNow(30_000);

  useAppEvents((e) => {
    dash.reload();
    if (e.type === 'MAILBOX_CREATED' || e.type === 'MAILBOX_DELETED' || e.type === 'RECONNECTED') firstMailbox.reload();
  });

  const d = dash.data;
  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Everything arriving at your disposable mailboxes, live.">
        <Link to="/mailboxes" className="btn btn-primary">
          Manage mailboxes
        </Link>
      </PageHeader>

      {dash.error && !d ? <ErrorBanner error={dash.error} title="Could not load the dashboard" onRetry={dash.reload} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat testId="stat-active-mailboxes" label="Active mailboxes" value={d?.activeMailboxes} />
        <Stat testId="stat-total-messages" label="Total messages" value={d?.totalMessages} />
        <Stat testId="stat-messages-today" label="Messages today" value={d?.messagesToday} />
        <Stat testId="stat-unread" label="Unread" value={d?.unreadMessages} />
        <Stat testId="stat-expiring" label="Expiring soon" value={d?.expiringSoon} hint="within 15 minutes" />
      </div>

      <section aria-labelledby="services-h" className="mt-6">
        <h2 id="services-h" className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Services
        </h2>
        <div className="flex flex-wrap gap-3">
          {(
            [
              ['Application', d?.app],
              ['Database', d?.database],
              ['SMTP capture', d?.smtp],
            ] as const
          ).map(([name, status]) => (
            <div key={name} className="card flex items-center gap-3 px-4 py-2.5 text-sm">
              <span>{name}</span>
              {status ? <StatusBadge status={status} /> : <Skeleton className="h-5 w-16" />}
            </div>
          ))}
          <Link to="/status" className="link self-center text-sm">
            Details
          </Link>
        </div>
      </section>

      <section aria-labelledby="recent-h" className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="recent-h" className="text-sm font-semibold text-slate-600 dark:text-slate-300">
            Recent messages
          </h2>
          <Link to="/messages" className="link text-sm">
            View all
          </Link>
        </div>
        <div className="card overflow-hidden">
          {!d ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : d.recentMessages.length === 0 ? (
            <EmptyState title="No messages yet">Create a mailbox and send it a test email. Messages appear here instantly.</EmptyState>
          ) : (
            <MessageTable items={d.recentMessages} now={now} showMailbox />
          )}
        </div>
      </section>

      {settings ? (
        <section aria-labelledby="snippet-h" className="mt-6">
          <h2 id="snippet-h" className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            Send a test email
          </h2>
          <div className="card p-4">
            <SendSnippet settings={settings} to={firstMailbox.data ?? undefined} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
