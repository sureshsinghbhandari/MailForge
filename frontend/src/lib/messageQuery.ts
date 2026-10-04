import { localDateToIso, startOfLocalDay } from './format';
import type { MessageFilter } from './types';

export const FILTERS: Array<{ value: MessageFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
  { value: 'attachments', label: 'With attachments' },
  { value: 'codes', label: 'With code' },
  { value: 'links', label: 'With links' },
  { value: 'today', label: 'Today' },
  { value: 'hour', label: 'Last hour' },
];

export const PAGE_SIZE = 25;

export interface ListParams {
  q: string;
  filter: MessageFilter;
  page: number;
  from: string;
  to: string;
  subject: string;
  /** `YYYY-MM-DD` (local) */
  dateFrom: string;
  dateTo: string;
  mailboxId: string;
}

export function parseListParams(sp: URLSearchParams): ListParams {
  const filter = sp.get('filter');
  const page = Number(sp.get('page') ?? '1');
  return {
    q: sp.get('q') ?? '',
    filter: FILTERS.some((f) => f.value === filter) ? (filter as MessageFilter) : 'all',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    subject: sp.get('subject') ?? '',
    dateFrom: sp.get('dateFrom') ?? '',
    dateTo: sp.get('dateTo') ?? '',
    mailboxId: sp.get('mailboxId') ?? '',
  };
}

/**
 * Translates UI state to `GET /api/messages` query params. The "Today" chip is implemented with a
 * client-computed local-midnight `dateFrom` so "today" follows the user's time zone, not the server's.
 */
export function buildMessageQuery(
  p: ListParams,
  opts: { now?: Date; mailboxId?: string | undefined } = {},
): Record<string, string | number | undefined> {
  const now = opts.now ?? new Date();
  let dateFrom = localDateToIso(p.dateFrom, false);
  if (p.filter === 'today') {
    const midnight = startOfLocalDay(now).toISOString();
    if (!dateFrom || dateFrom < midnight) dateFrom = midnight;
  }
  const mailboxId = opts.mailboxId ?? (p.mailboxId || undefined);
  return {
    search: p.q.trim() || undefined,
    from: p.from.trim() || undefined,
    to: p.to.trim() || undefined,
    subject: p.subject.trim() || undefined,
    dateFrom,
    dateTo: localDateToIso(p.dateTo, true),
    filter: p.filter === 'all' || p.filter === 'today' ? undefined : p.filter,
    mailboxId,
    page: p.page,
    pageSize: PAGE_SIZE,
  };
}

export function hasActiveFilters(p: ListParams): boolean {
  return Boolean(p.q || p.filter !== 'all' || p.from || p.to || p.subject || p.dateFrom || p.dateTo || p.mailboxId);
}
