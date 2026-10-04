import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppEvents } from '../context/events';
import { useNow } from '../hooks/useNow';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import { FILTERS, PAGE_SIZE, buildMessageQuery, hasActiveFilters, parseListParams, type ListParams } from '../lib/messageQuery';
import type { Mailbox, MessageFilter, MessageSummary } from '../lib/types';
import { DebouncedInput } from './DebouncedInput';
import { MessageTable } from './MessageTable';
import { EmptyState, ErrorBanner, Pagination, TableSkeleton } from './ui';

/**
 * Searchable, filterable, paginated message table. State lives in the URL (?q=&filter=&page=...).
 * With `mailboxId` it lists one inbox; without it, it searches across all mailboxes.
 */
export function MessageList({ mailboxId, emptyHint }: { mailboxId?: string; emptyHint?: ReactNode }) {
  const [sp, setSp] = useSearchParams();
  const params = parseListParams(sp);
  const global = mailboxId === undefined;
  const now = useNow(15_000);
  const [resetKey, setResetKey] = useState(0);

  const query = buildMessageQuery(params, { mailboxId });
  const path = global ? '/messages' : `/mailboxes/${mailboxId}/messages`;
  const key = `${path}?${JSON.stringify(query)}`;
  const list = useQuery(key, async (signal) => {
    const { data, meta } = await api.get<MessageSummary[]>(path, query, { signal });
    return { items: data, total: meta?.total ?? data.length };
  });

  useAppEvents((e) => {
    if (e.type === 'RECONNECTED' || e.type === 'MESSAGES_CLEARED' || e.type === 'MAILBOX_DELETED') list.reload();
    else if (e.type === 'EMAIL_RECEIVED' || e.type === 'MESSAGE_DELETED') {
      if (global || e.mailboxId === mailboxId) list.reload();
    }
  });

  const mailboxes = useQuery(global ? 'mailbox-options' : null, async (signal) => (await api.get<Mailbox[]>('/mailboxes', { pageSize: 100 }, { signal })).data);

  function update(patch: Partial<Record<keyof ListParams, string>>, keepPage = false) {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '' || (k === 'filter' && v === 'all')) next.delete(k);
          else next.set(k, v);
        }
        if (!keepPage) next.delete('page');
        return next;
      },
      { replace: true },
    );
  }

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtersActive = hasActiveFilters(params);

  return (
    <div className="card overflow-hidden">
      <div className="space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div>
          <label htmlFor="message-search" className="sr-only">
            Search messages
          </label>
          <DebouncedInput
            key={`q-${resetKey}`}
            id="message-search"
            type="search"
            className="input"
            placeholder={global ? 'Search subject, sender, body, codes...' : 'Search this inbox...'}
            value={params.q}
            onCommit={(v) => update({ q: v })}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter messages">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="chip"
              aria-pressed={params.filter === f.value}
              onClick={() => update({ filter: f.value as MessageFilter })}
            >
              {f.label}
            </button>
          ))}
        </div>
        {global ? (
          <details className="group" open={Boolean(params.mailboxId || params.from || params.to || params.subject || params.dateFrom || params.dateTo)}>
            <summary className="cursor-pointer text-sm font-medium text-indigo-700 dark:text-indigo-300">Advanced filters</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="label" htmlFor="f-mailbox">
                  Mailbox
                </label>
                <select id="f-mailbox" className="input" value={params.mailboxId} onChange={(e) => update({ mailboxId: e.target.value })}>
                  <option value="">All mailboxes</option>
                  {(mailboxes.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="f-from">
                  From
                </label>
                <DebouncedInput key={`from-${resetKey}`} id="f-from" className="input" value={params.from} onCommit={(v) => update({ from: v })} />
              </div>
              <div>
                <label className="label" htmlFor="f-to">
                  To
                </label>
                <DebouncedInput key={`to-${resetKey}`} id="f-to" className="input" value={params.to} onCommit={(v) => update({ to: v })} />
              </div>
              <div>
                <label className="label" htmlFor="f-subject">
                  Subject
                </label>
                <DebouncedInput key={`subject-${resetKey}`} id="f-subject" className="input" value={params.subject} onCommit={(v) => update({ subject: v })} />
              </div>
              <div>
                <label className="label" htmlFor="f-date-from">
                  Received on or after
                </label>
                <input id="f-date-from" type="date" className="input" value={params.dateFrom} onChange={(e) => update({ dateFrom: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="f-date-to">
                  Received on or before
                </label>
                <input id="f-date-to" type="date" className="input" value={params.dateTo} onChange={(e) => update({ dateTo: e.target.value })} />
              </div>
            </div>
          </details>
        ) : null}
        {filtersActive ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setSp({}, { replace: true });
              setResetKey((k) => k + 1);
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {list.error && !list.data ? (
        <div className="p-4">
          <ErrorBanner error={list.error} title="Could not load messages" onRetry={list.reload} />
        </div>
      ) : list.initialLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        filtersActive ? (
          <EmptyState title="No messages match your filters">Try a different search term or clear the filters.</EmptyState>
        ) : (
          (emptyHint ?? <EmptyState title="No messages yet" />)
        )
      ) : (
        <div className={list.loading ? 'opacity-70 transition-opacity' : ''}>
          {list.error ? (
            <div className="p-4">
              <ErrorBanner error={list.error} onRetry={list.reload} />
            </div>
          ) : null}
          <MessageTable items={items} now={now} showMailbox={global} />
        </div>
      )}

      <Pagination
        page={params.page}
        pageSize={PAGE_SIZE}
        total={total}
        noun="messages"
        onPage={(p) => update({ page: String(p) }, true)}
      />
    </div>
  );
}
