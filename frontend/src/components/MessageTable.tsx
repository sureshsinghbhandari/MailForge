import { Link, useNavigate } from 'react-router-dom';
import { formatDateTime, formatRelative } from '../lib/format';
import type { MessageSummary } from '../lib/types';
import { KeyIcon, LinkIcon, PaperclipIcon } from './icons';

function StatusIcons({ m }: { m: MessageSummary }) {
  return (
    <span className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400">
      {m.attachmentCount > 0 ? (
        <span className="inline-flex items-center gap-0.5" title={`${m.attachmentCount} attachment(s)`}>
          <PaperclipIcon width={14} height={14} />
          <span className="sr-only">{m.attachmentCount} attachment(s)</span>
        </span>
      ) : null}
      {m.codeCount > 0 ? (
        <span className="inline-flex items-center gap-0.5" title={`${m.codeCount} detected code(s)`}>
          <KeyIcon width={14} height={14} />
          <span className="sr-only">{m.codeCount} detected code(s)</span>
        </span>
      ) : null}
      {m.linkCount > 0 ? (
        <span className="inline-flex items-center gap-0.5" title={`${m.linkCount} link(s)`}>
          <LinkIcon width={14} height={14} />
          <span className="sr-only">{m.linkCount} link(s)</span>
        </span>
      ) : null}
    </span>
  );
}

/** Message rows. On phones each row collapses into a stacked card; the header row is visually hidden. */
export function MessageTable({ items, now, showMailbox = false }: { items: MessageSummary[]; now: number; showMailbox?: boolean }) {
  const navigate = useNavigate();
  return (
    <table className="w-full table-fixed">
      <thead className="sr-only md:not-sr-only md:table-header-group">
        <tr className="border-b border-slate-200 dark:border-slate-800">
          <th scope="col" className="th w-44">From</th>
          <th scope="col" className="th">Subject</th>
          {showMailbox ? <th scope="col" className="th hidden w-48 xl:table-cell">Mailbox</th> : null}
          <th scope="col" className="th w-28">Received</th>
          <th scope="col" className="th w-24">Status</th>
        </tr>
      </thead>
      <tbody className="block md:table-row-group">
        {items.map((m) => (
          <tr
            key={m.id}
            data-testid="message-row"
            data-unread={m.isRead ? 'false' : 'true'}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a,button')) return;
              void navigate(`/messages/${m.id}`);
            }}
            className={`block cursor-pointer border-b border-slate-100 px-4 py-3 hover:bg-slate-50 md:table-row md:px-0 md:py-0 dark:border-slate-800/70 dark:hover:bg-slate-800/50 ${
              m.isRead ? '' : 'bg-indigo-50/40 dark:bg-indigo-950/20'
            }`}
          >
            <td className={`td block px-0 py-0 md:table-cell md:px-3 md:py-2.5 ${m.isRead ? '' : 'font-semibold'}`}>
              <span className="block truncate" title={m.fromAddress}>
                {m.fromName || m.fromAddress}
              </span>
              {m.fromName ? (
                <span className="block truncate text-xs font-normal text-slate-500 dark:text-slate-400">{m.fromAddress}</span>
              ) : null}
            </td>
            <td className="td block px-0 py-0.5 md:table-cell md:px-3 md:py-2.5">
              <Link
                to={`/messages/${m.id}`}
                className={`block max-w-full truncate no-underline hover:underline ${m.isRead ? '' : 'font-semibold'}`}
              >
                {m.subject || '(no subject)'}
              </Link>
              {m.preview ? (
                <span className="block max-w-full truncate text-xs text-slate-500 dark:text-slate-400">{m.preview}</span>
              ) : null}
              {showMailbox ? (
                <span className="hidden truncate font-mono text-xs text-indigo-700 md:block xl:hidden dark:text-indigo-300">{m.mailboxEmail}</span>
              ) : null}
            </td>
            {showMailbox ? (
              <td className="td block px-0 py-0 text-xs text-slate-500 md:hidden xl:table-cell xl:px-3 xl:py-2.5 dark:text-slate-400">
                <Link to={`/mailboxes/${m.mailboxId}`} className="link block truncate font-mono">
                  {m.mailboxEmail}
                </Link>
              </td>
            ) : null}
            <td className="td block px-0 py-0.5 text-xs text-slate-500 md:table-cell md:px-3 md:py-2.5 dark:text-slate-400">
              <time dateTime={m.receivedAt} title={formatDateTime(m.receivedAt)}>
                {formatRelative(m.receivedAt, now)}
              </time>
            </td>
            <td className="td block px-0 py-0.5 md:table-cell md:px-3 md:py-2.5">
              <span className="inline-flex items-center gap-2">
                {m.isRead ? (
                  <span className="sr-only">Read</span>
                ) : (
                  <span className="inline-flex items-center" title="Unread">
                    <span aria-hidden="true" className="size-2.5 rounded-full bg-indigo-500" />
                    <span className="sr-only">Unread</span>
                  </span>
                )}
                <StatusIcons m={m} />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
