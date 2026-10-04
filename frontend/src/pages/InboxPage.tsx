import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { TrashIcon } from '../components/icons';
import { MessageList } from '../components/MessageList';
import { SendSnippet } from '../components/SendSnippet';
import { EmptyState, ErrorBanner, Skeleton } from '../components/ui';
import { useAppEvents } from '../context/events';
import { useSettings } from '../context/settings';
import { useToast } from '../context/toast';
import { useNow } from '../hooks/useNow';
import { useQuery } from '../hooks/useQuery';
import { ApiError, api } from '../lib/api';
import { formatCountdown, formatDateTime, msUntil } from '../lib/format';
import type { Mailbox } from '../lib/types';

export function InboxPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useSettings();
  const now = useNow(1000);
  const deletingSelf = useRef(false);
  const [confirm, setConfirm] = useState<'mailbox' | 'messages' | null>(null);

  const box = useQuery(`mailbox:${id}`, async (signal) => (await api.get<Mailbox>(`/mailboxes/${id}`, undefined, { signal })).data);

  useAppEvents((e) => {
    if (deletingSelf.current) return;
    if (e.type === 'MAILBOX_DELETED' && e.mailboxId === id) {
      toast.push({ message: 'This mailbox was deleted.', kind: 'info' });
      void navigate('/mailboxes');
    } else if (e.type === 'RECONNECTED' || ('mailboxId' in e && e.mailboxId === id)) {
      box.reload();
    }
  });

  if (box.error && !box.data) {
    const notFound = box.error instanceof ApiError && box.error.status === 404;
    return (
      <div className="space-y-4">
        <ErrorBanner error={box.error} title={notFound ? 'Mailbox not found' : 'Could not load mailbox'} onRetry={notFound ? undefined : box.reload} />
        <Link to="/mailboxes" className="btn">
          Back to mailboxes
        </Link>
      </div>
    );
  }

  const m = box.data;
  const left = m ? msUntil(m.expiresAt, now) : 0;
  const expired = m ? left <= 0 : false;

  return (
    <div>
      <div className="mb-1">
        <Link to="/mailboxes" className="link text-sm">
          &larr; Mailboxes
        </Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="sr-only">Inbox</h1>
          {m ? (
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="mailbox-address" className="break-all font-mono text-lg font-semibold sm:text-xl">
                {m.email}
              </span>
              <CopyButton text={m.email} ariaLabel="Copy email address" label="Copy" />
            </div>
          ) : (
            <Skeleton className="h-8 w-72 max-w-full" />
          )}
          {m ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400" title={`Expires ${formatDateTime(m.expiresAt)}`}>
              {expired ? (
                <span className="font-medium text-red-600 dark:text-red-400">Expired</span>
              ) : (
                <>
                  Expires in <span className="tabular-nums font-medium">{formatCountdown(left)}</span>
                </>
              )}
              {' · '}
              {m.messageCount} message(s), {m.unreadCount} unread
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost-danger" onClick={() => setConfirm('messages')} disabled={!m}>
            Delete all messages
          </button>
          <button type="button" className="btn btn-ghost-danger" onClick={() => setConfirm('mailbox')} disabled={!m}>
            <TrashIcon />
            Delete mailbox
          </button>
        </div>
      </div>

      {expired ? (
        <div className="banner banner-warn mb-4">
          <p>This mailbox has expired and no longer receives mail. Existing messages are kept until the retention period ends.</p>
        </div>
      ) : null}

      <MessageList
        mailboxId={id}
        emptyHint={
          <EmptyState title="No messages yet">
            <p className="mb-4">Send an email to this address and it will appear here instantly.</p>
            {settings && m ? (
              <div className="text-left">
                <SendSnippet settings={settings} to={m.email} />
              </div>
            ) : null}
          </EmptyState>
        }
      />

      {confirm === 'messages' && m ? (
        <ConfirmDialog
          title="Delete all messages?"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const { data } = await api.delete<{ deleted: number }>(`/mailboxes/${id}/messages`, { confirm: 'true' });
            setConfirm(null);
            toast.push({ message: `Deleted ${data.deleted} message(s)`, kind: 'success' });
            box.reload();
          }}
        >
          <p>
            All {m.messageCount} message(s) in <span className="break-all font-mono">{m.email}</span> will be permanently deleted. This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}

      {confirm === 'mailbox' && m ? (
        <ConfirmDialog
          title="Delete mailbox?"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            deletingSelf.current = true;
            try {
              await api.delete(`/mailboxes/${id}`);
            } catch (err) {
              deletingSelf.current = false;
              throw err;
            }
            toast.push({ message: `Deleted ${m.email}`, kind: 'success' });
            void navigate('/mailboxes');
          }}
        >
          <p>
            <span className="break-all font-mono">{m.email}</span> and all of its messages will be permanently deleted. This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
