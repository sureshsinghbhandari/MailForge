import { useState, type ReactNode } from 'react';
import { SendSnippet } from '../components/SendSnippet';
import { ErrorBanner, PageHeader, Skeleton } from '../components/ui';
import { useSettings } from '../context/settings';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import { formatDateTime, formatHours, ttlLabel } from '../lib/format';
import type { CleanupResult, Mailbox } from '../lib/types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
      <th scope="row" className="td w-1/2 text-left font-medium text-slate-600 sm:w-72 dark:text-slate-300">
        {label}
      </th>
      <td className="td break-words font-mono text-xs sm:text-sm">{children}</td>
    </tr>
  );
}

export function CleanupResultView({ result }: { result: CleanupResult }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="cleanup-result">
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Mailboxes deleted</dt>
        <dd className="font-semibold tabular-nums">{result.mailboxesDeleted}</dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Messages deleted</dt>
        <dd className="font-semibold tabular-nums">{result.messagesDeleted}</dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Attachment files deleted</dt>
        <dd className="font-semibold tabular-nums">{result.attachmentFilesDeleted}</dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Sessions deleted</dt>
        <dd className="font-semibold tabular-nums">{result.sessionsDeleted}</dd>
      </div>
      <div className="col-span-2 sm:col-span-4 text-xs text-slate-500 dark:text-slate-400">
        Ran {formatDateTime(result.ranAt)} in {result.durationMs} ms
      </div>
    </dl>
  );
}

export function SettingsPage() {
  const { settings: s, error, reload } = useSettings();
  const firstMailbox = useQuery('settings-first-mailbox', async (signal) => (await api.get<Mailbox[]>('/mailboxes', { status: 'active', pageSize: 1 }, { signal })).data[0]?.email ?? null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [runError, setRunError] = useState<unknown>(null);

  async function runCleanup() {
    setRunning(true);
    setRunError(null);
    try {
      setResult((await api.post<CleanupResult>('/system/cleanup')).data);
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Read-only runtime configuration. Change it with environment variables on the server." />

      {error && !s ? (
        <ErrorBanner error={error} title="Could not load settings" onRetry={reload} />
      ) : !s ? (
        <div className="space-y-3">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="cfg-h" className="card overflow-hidden">
            <h2 id="cfg-h" className="border-b border-slate-200 px-4 py-3 text-sm font-semibold dark:border-slate-800">
              Configuration
            </h2>
            <table className="w-full">
              <tbody>
                <Row label="Environment">{s.environment}</Row>
                <Row label="Mail domain(s)">{s.mailDomains.join(', ')}</Row>
                <Row label="SMTP host (send test mail here)">{s.smtpHost}</Row>
                <Row label="SMTP port">{s.smtpPort}</Row>
                <Row label="Default mailbox lifetime">{ttlLabel(s.defaultMailboxTtlMinutes)}</Row>
                <Row label="Maximum mailbox lifetime">{ttlLabel(s.maxMailboxTtlMinutes)}</Row>
                <Row label="Max email size">{s.maxEmailSizeMb} MB</Row>
                <Row label="Max attachment size">{s.maxAttachmentSizeMb} MB</Row>
                <Row label="Message retention">{formatHours(s.messageRetentionHours)}</Row>
                <Row label="Attachment retention">{formatHours(s.attachmentRetentionHours)}</Row>
                <Row label="Expired mailbox retention">{formatHours(s.mailboxRetentionHours)}</Row>
                <Row label="Cleanup interval">{s.cleanupIntervalSeconds} s</Row>
                <Row label="API authentication">{s.apiAuthEnabled ? 'Required' : 'Disabled (development only)'}</Row>
                <Row label="Rate limit: login">{s.rateLimits.login}</Row>
                <Row label="Rate limit: API">{s.rateLimits.api}</Row>
                <Row label="Rate limit: mailbox creation">{s.rateLimits.mailboxCreation}</Row>
                <Row label="Rate limit: search">{s.rateLimits.search}</Row>
                <Row label="Rate limit: downloads">{s.rateLimits.download}</Row>
              </tbody>
            </table>
          </section>

          <section aria-labelledby="cleanup-h" className="card p-4">
            <h2 id="cleanup-h" className="mb-1 text-sm font-semibold">
              Maintenance
            </h2>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Cleanup runs automatically every {s.cleanupIntervalSeconds} s. Run it now to purge expired mailboxes and old messages immediately.
            </p>
            <button type="button" className="btn" onClick={() => void runCleanup()} disabled={running}>
              {running ? 'Running cleanup…' : 'Run cleanup now'}
            </button>
            {runError ? (
              <div className="mt-3">
                <ErrorBanner error={runError} />
              </div>
            ) : null}
            {result ? (
              <div className="mt-4">
                <CleanupResultView result={result} />
              </div>
            ) : null}
          </section>

          <section aria-labelledby="appearance-h" className="card p-4">
            <h2 id="appearance-h" className="mb-1 text-sm font-semibold">
              Appearance
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Theme: system. The interface follows your operating system&rsquo;s light or dark setting.</p>
          </section>

          <section aria-labelledby="snippet-h" className="card p-4">
            <h2 id="snippet-h" className="mb-3 text-sm font-semibold">
              Send a test email
            </h2>
            <SendSnippet settings={s} to={firstMailbox.data ?? undefined} />
          </section>
        </div>
      )}
    </div>
  );
}
