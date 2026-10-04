import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MessageView } from '../components/MessageView';
import { ErrorBanner, Skeleton } from '../components/ui';
import { useAppEvents, useEvents } from '../context/events';
import { useToast } from '../context/toast';
import { useQuery } from '../hooks/useQuery';
import { ApiError, api } from '../lib/api';
import type { MessageDetail } from '../lib/types';

function MessageLoader({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { refreshUnread } = useEvents();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const autoMarked = useRef(false);
  const deletingSelf = useRef(false);

  const q = useQuery(`message:${id}`, async (signal) => (await api.get<MessageDetail>(`/messages/${id}`, undefined, { signal })).data);
  const { data: message, setData } = q;

  function goBack(mailboxId?: string) {
    // Prefer real history so filters/pages in the list are preserved.
    if (location.key !== 'default') void navigate(-1);
    else void navigate(mailboxId ? `/mailboxes/${mailboxId}` : '/messages');
  }

  // Opening a message does not mark it read on the server; do it once when the viewer opens an unread one.
  useEffect(() => {
    if (!message || message.isRead || autoMarked.current) return;
    autoMarked.current = true;
    api
      .patch<{ isRead: boolean }>(`/messages/${message.id}`, { isRead: true })
      .then(() => {
        setData((m) => ({ ...m, isRead: true }));
        refreshUnread();
      })
      .catch(() => undefined);
  }, [message, setData, refreshUnread]);

  useAppEvents((e) => {
    if (deletingSelf.current) return;
    if (e.type === 'MESSAGE_DELETED' && e.messageId === id) {
      toast.push({ message: 'This message was deleted.' });
      goBack(message?.mailboxId);
    } else if (e.type === 'MAILBOX_DELETED' && message && e.mailboxId === message.mailboxId) {
      void navigate('/mailboxes');
    }
  });

  async function toggleRead() {
    if (!message) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.patch(`/messages/${message.id}`, { isRead: !message.isRead });
      setData((m) => ({ ...m, isRead: !m.isRead }));
      refreshUnread();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  if (q.error && !message) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-4">
        <ErrorBanner error={q.error} title={notFound ? 'Message not found' : 'Could not load message'} onRetry={notFound ? undefined : q.reload} />
        <Link to="/messages" className="btn">
          Back to messages
        </Link>
      </div>
    );
  }
  if (!message) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading message">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div>
      {actionError ? (
        <div className="mb-4">
          <ErrorBanner error={actionError} />
        </div>
      ) : null}
      <MessageView
        key={message.id}
        message={message}
        busy={busy}
        onBack={() => goBack(message.mailboxId)}
        onDelete={() => setConfirmDelete(true)}
        onToggleRead={() => void toggleRead()}
      />
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete message?"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            deletingSelf.current = true;
            try {
              await api.delete(`/messages/${message.id}`);
            } catch (err) {
              deletingSelf.current = false;
              throw err;
            }
            refreshUnread();
            toast.push({ message: 'Message deleted', kind: 'success' });
            void navigate(`/mailboxes/${message.mailboxId}`, { replace: true });
          }}
        >
          <p>
            Permanently delete &ldquo;<span className="break-words font-medium">{message.subject || '(no subject)'}</span>&rdquo;? This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export function MessagePage() {
  const { id = '' } = useParams();
  // Keyed so state (tab, remote-image toggle, auto-mark) never leaks between messages.
  return <MessageLoader key={id} id={id} />;
}
