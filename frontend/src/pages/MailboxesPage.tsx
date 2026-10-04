import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { TrashIcon } from '../components/icons';
import { Modal } from '../components/Modal';
import { EmptyState, ErrorBanner, PageHeader, Pagination, StatusBadge, TableSkeleton } from '../components/ui';
import { useToast } from '../context/toast';
import { useAppEvents } from '../context/events';
import { useSettings } from '../context/settings';
import { useNow } from '../hooks/useNow';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import { formatCountdown, formatDateTime, msUntil, ttlLabel } from '../lib/format';
import type { Mailbox, PublicSettings } from '../lib/types';

const PAGE_SIZE = 25;

function NewMailboxDialog({ settings, onClose }: { settings: PublicSettings; onClose: () => void }) {
  const navigate = useNavigate();
  const max = settings.maxMailboxTtlMinutes;
  const presets = settings.ttlPresetsMinutes.filter((m) => m <= max);
  const initial = presets.includes(settings.defaultMailboxTtlMinutes) ? String(settings.defaultMailboxTtlMinutes) : String(presets[0] ?? 'custom');
  const [prefix, setPrefix] = useState('');
  const [ttl, setTtl] = useState(initial);
  const [custom, setCustom] = useState('');
  const [domain, setDomain] = useState(settings.mailDomains[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const prefixRef = useRef<HTMLInputElement>(null);

  const customMinutes = Number(custom);
  const customInvalid = ttl === 'custom' && (!Number.isInteger(customMinutes) || customMinutes < 1 || customMinutes > max);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (customInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const body: { prefix?: string; ttlMinutes: number; domain?: string } = {
        ttlMinutes: ttl === 'custom' ? customMinutes : Number(ttl),
      };
      if (prefix.trim()) body.prefix = prefix.trim();
      if (settings.mailDomains.length > 1) body.domain = domain;
      const { data } = await api.post<Mailbox>('/mailboxes', body);
      onClose();
      void navigate(`/mailboxes/${data.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title="New mailbox" onClose={onClose} initialFocus={prefixRef}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {error ? <ErrorBanner error={error} /> : null}
        <div>
          <label htmlFor="mb-prefix" className="label">
            Prefix
          </label>
          <input
            ref={prefixRef}
            id="mb-prefix"
            className="input font-mono"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="test"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            aria-describedby="mb-prefix-hint"
          />
          <p id="mb-prefix-hint" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Optional. 1-32 characters: lowercase letters, digits, dot, underscore or dash. A random suffix is added, e.g.{' '}
            <span className="font-mono">{prefix.trim() || 'test'}-a8f72c@{domain || 'example.test'}</span>.
          </p>
        </div>
        {settings.mailDomains.length > 1 ? (
          <div>
            <label htmlFor="mb-domain" className="label">
              Domain
            </label>
            <select id="mb-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
              {settings.mailDomains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor="mb-ttl" className="label">
            Expires after
          </label>
          <select id="mb-ttl" className="input" value={ttl} onChange={(e) => setTtl(e.target.value)}>
            {presets.map((m) => (
              <option key={m} value={m}>
                {ttlLabel(m)}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </div>
        {ttl === 'custom' ? (
          <div>
            <label htmlFor="mb-custom" className="label">
              Custom minutes
            </label>
            <input
              id="mb-custom"
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              step={1}
              className="input"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={customInvalid && custom !== ''}
              aria-describedby="mb-custom-hint"
              required
            />
            <p id="mb-custom-hint" className={`mt-1 text-xs ${customInvalid && custom !== '' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
              Whole minutes, 1 to {max} ({ttlLabel(max)}).
            </p>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || customInvalid}>
            Create mailbox
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MailboxesPage() {
  const [sp, setSp] = useSearchParams();
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const status = sp.get('status') === 'active' || sp.get('status') === 'expired' ? sp.get('status') : '';
  const now = useNow(1000);
  const toast = useToast();
  const { settings, error: settingsError } = useSettings();
  const [showNew, setShowNew] = useState(false);
  const [toDelete, setToDelete] = useState<Mailbox | null>(null);
  const [confirmExpired, setConfirmExpired] = useState(false);

  const list = useQuery(`mailboxes:${page}:${status}`, async (signal) => {
    const { data, meta } = await api.get<Mailbox[]>('/mailboxes', { page, pageSize: PAGE_SIZE, status }, { signal });
    return { items: data, total: meta?.total ?? data.length };
  });

  useAppEvents(() => list.reload());

  const items = list.data?.items ?? [];

  function setStatus(next: string) {
    setSp(next ? { status: next } : {}, { replace: true });
  }

  return (
    <div>
      <PageHeader title="Mailboxes" subtitle="Disposable addresses that receive mail until they expire.">
        <button type="button" className="btn btn-ghost-danger" onClick={() => setConfirmExpired(true)}>
          <TrashIcon />
          Delete expired
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)} disabled={!settings}>
          New mailbox
        </button>
      </PageHeader>

      {settingsError && !settings ? <div className="mb-4"><ErrorBanner error={settingsError} title="Could not load settings" /></div> : null}

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {[
          ['', 'All'],
          ['active', 'Active'],
          ['expired', 'Expired'],
        ].map(([value, label]) => (
          <button key={value} type="button" className="chip" aria-pressed={status === value} onClick={() => setStatus(value as string)}>
            {label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {list.error && !list.data ? (
          <div className="p-4">
            <ErrorBanner error={list.error} title="Could not load mailboxes" onRetry={list.reload} />
          </div>
        ) : list.initialLoading ? (
          <TableSkeleton />
        ) : items.length === 0 ? (
          <EmptyState title="No mailboxes">Create a mailbox to get a disposable address you can send test email to.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem]">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="th">Address</th>
                  <th scope="col" className="th">Status</th>
                  <th scope="col" className="th">Expires</th>
                  <th scope="col" className="th text-right">Messages</th>
                  <th scope="col" className="th text-right">Unread</th>
                  <th scope="col" className="th text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => {
                  const left = msUntil(m.expiresAt, now);
                  const expired = left <= 0;
                  return (
                    <tr key={m.id} data-testid="mailbox-row" className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
                      <td className="td">
                        <Link to={`/mailboxes/${m.id}`} className="link break-all font-mono">
                          {m.email}
                        </Link>
                      </td>
                      <td className="td">
                        <StatusBadge status={expired ? 'expired' : 'active'} />
                      </td>
                      <td className="td whitespace-nowrap tabular-nums" title={formatDateTime(m.expiresAt)}>
                        {expired ? <span className="text-red-600 dark:text-red-400">Expired</span> : <span className={left < 5 * 60_000 ? 'text-amber-600 dark:text-amber-400' : ''}>{formatCountdown(left)}</span>}
                      </td>
                      <td className="td text-right tabular-nums">{m.messageCount}</td>
                      <td className="td text-right tabular-nums">{m.unreadCount}</td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <CopyButton text={m.email} ariaLabel={`Copy ${m.email}`} iconOnly className="icon-btn" />
                          <button type="button" className="icon-btn text-red-600 dark:text-red-400" aria-label={`Delete ${m.email}`} title="Delete mailbox" onClick={() => setToDelete(m)}>
                            <TrashIcon />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={list.data?.total ?? 0}
          noun="mailboxes"
          onPage={(p) => setSp({ ...(status ? { status } : {}), page: String(p) }, { replace: true })}
        />
      </div>

      {showNew && settings ? <NewMailboxDialog settings={settings} onClose={() => setShowNew(false)} /> : null}

      {toDelete ? (
        <ConfirmDialog
          title="Delete mailbox?"
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            await api.delete(`/mailboxes/${toDelete.id}`);
            setToDelete(null);
            toast.push({ message: `Deleted ${toDelete.email}`, kind: 'success' });
            list.reload();
          }}
        >
          <p>
            Permanently delete <span className="break-all font-mono">{toDelete.email}</span> and its {toDelete.messageCount} message(s)? This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}

      {confirmExpired ? (
        <ConfirmDialog
          title="Delete all expired mailboxes?"
          onCancel={() => setConfirmExpired(false)}
          onConfirm={async () => {
            const { data } = await api.delete<{ deleted: number }>('/mailboxes/expired', { confirm: 'true' });
            setConfirmExpired(false);
            toast.push({ message: `Deleted ${data.deleted} expired mailbox(es)`, kind: 'success' });
            list.reload();
          }}
        >
          <p>All expired mailboxes and their messages will be permanently deleted. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
