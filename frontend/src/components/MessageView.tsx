import { useEffect, useMemo, useState } from 'react';
import { ApiError, attachmentUrl, rawDownloadUrl, requestText } from '../lib/api';
import { sortCodes, sortLinks } from '../lib/detected';
import { formatBytes, formatDateTime, isHttpUrl, senderLabel } from '../lib/format';
import type { AttachmentView, MessageDetail } from '../lib/types';
import { CopyButton } from './CopyButton';
import { EmailFrame } from './EmailFrame';
import { ArrowLeftIcon, ExternalIcon, TrashIcon } from './icons';
import { Tabs, type TabDef } from './Tabs';
import { ErrorBanner, Spinner } from './ui';

const RAW_DISPLAY_LIMIT = 1_000_000;

function DetectedPanel({ message }: { message: MessageDetail }) {
  const codes = useMemo(() => sortCodes(message.codes), [message.codes]);
  const links = useMemo(() => sortLinks(message.links), [message.links]);
  if (codes.length === 0 && links.length === 0) return null;
  return (
    <section aria-labelledby="detected-h" className="card mb-5 p-4">
      <h2 id="detected-h" className="mb-3 text-sm font-semibold text-slate-600 dark:text-slate-300">
        Detected
      </h2>
      {codes.length > 0 ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Verification codes</h3>
          <ul className="flex flex-wrap gap-3">
            {codes.map((c, i) => (
              <li key={`${c.code}-${i}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                <span data-testid="detected-code" className="font-mono text-2xl font-bold tracking-widest">
                  {c.code}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{Math.round(c.confidence * 100)}%</span>
                <CopyButton text={c.code} ariaLabel={`Copy code ${c.code}`} label="Copy" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {links.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Links ({links.length})</h3>
          <ul className="max-h-72 space-y-2 overflow-auto">
            {links.map((l, i) => {
              const safe = isHttpUrl(l.url);
              return (
                <li key={`${l.url}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                  <span className="badge badge-gray">{l.linkType.replace(/_/g, ' ')}</span>
                  {l.isVerification ? <span className="badge badge-green">likely verification</span> : null}
                  <span data-testid="detected-link" className="order-last w-full break-all font-mono text-xs sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:text-sm">
                    {l.url}
                  </span>
                  <span className="flex shrink-0 gap-2">
                    {safe ? (
                      <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="btn btn-sm">
                        Open
                        <ExternalIcon width={12} height={12} />
                        <span className="sr-only"> (new tab)</span>
                      </a>
                    ) : (
                      <span className="badge badge-amber" title="Only http(s) links can be opened">
                        not http(s)
                      </span>
                    )}
                    <CopyButton text={l.url} ariaLabel="Copy link" label="Copy" />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function HeadersTable({ headers }: { headers: MessageDetail['headers'] }) {
  if (headers.length === 0) return <p className="text-sm text-slate-500">No headers stored.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="th w-48">Header</th>
            <th scope="col" className="th">Value</th>
          </tr>
        </thead>
        <tbody>
          {headers.map((h, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
              <th scope="row" className="td w-48 whitespace-nowrap font-mono text-xs font-semibold">
                {h.name}
              </th>
              <td className="td break-all font-mono text-xs">{h.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawSource({ messageId }: { messageId: string }) {
  const [state, setState] = useState<{ id: string; text?: string; error?: unknown } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestText(`/messages/${encodeURIComponent(messageId)}/raw`, { signal: controller.signal }).then(
      (text) => setState({ id: messageId, text }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ id: messageId, error });
      },
    );
    return () => controller.abort();
  }, [messageId]);

  if (!state || state.id !== messageId) return <Spinner label="Loading source" />;
  if (state.error !== undefined) return <ErrorBanner error={state.error instanceof ApiError || state.error instanceof Error ? state.error : new Error('Could not load source')} />;
  const text = state.text ?? '';
  const truncated = text.length > RAW_DISPLAY_LIMIT;
  return (
    <div className="space-y-3">
      {truncated ? (
        <div className="banner banner-warn">
          Showing the first 1 MB of {formatBytes(text.length)}. Use &ldquo;Download .eml&rdquo; for the full message.
        </div>
      ) : null}
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-4 font-mono text-xs dark:border-slate-700 dark:bg-slate-900">
        {truncated ? text.slice(0, RAW_DISPLAY_LIMIT) : text}
      </pre>
    </div>
  );
}

function AttachmentsTable({ messageId, attachments }: { messageId: string; attachments: AttachmentView[] }) {
  if (attachments.length === 0) return <p className="text-sm text-slate-500 dark:text-slate-400">This message has no attachments.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="th">File</th>
            <th scope="col" className="th">Type</th>
            <th scope="col" className="th">Size</th>
            <th scope="col" className="th">
              <span className="sr-only">Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {attachments.map((a) => (
            <tr key={a.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
              <td className="td break-all">{a.filename}</td>
              <td className="td font-mono text-xs">{a.mimeType}</td>
              <td className="td whitespace-nowrap">{formatBytes(a.size)}</td>
              <td className="td">
                {a.stored ? (
                  <a href={attachmentUrl(messageId, a.id)} download className="btn btn-sm">
                    Download
                    <span className="sr-only"> {a.filename}</span>
                  </a>
                ) : (
                  <span className="badge badge-gray">not stored</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MessageView({
  message,
  busy = false,
  onBack,
  onDelete,
  onToggleRead,
}: {
  message: MessageDetail;
  busy?: boolean;
  onBack: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
}) {
  const hasHtml = message.html !== null;
  const [tab, setTab] = useState<string>(hasHtml ? 'html' : 'text');
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  const tabs: TabDef[] = [
    { id: 'html', label: 'HTML' },
    { id: 'text', label: 'Text' },
    { id: 'headers', label: 'Headers' },
    { id: 'raw', label: 'Raw' },
    { id: 'attachments', label: 'Attachments', badge: message.attachments.length },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeftIcon />
          Back
        </button>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={onToggleRead} disabled={busy}>
            {message.isRead ? 'Mark unread' : 'Mark read'}
          </button>
          <a href={rawDownloadUrl(message.id)} download="message.eml" className="btn">
            Download .eml
          </a>
          <button type="button" className="btn btn-ghost-danger" onClick={onDelete} disabled={busy}>
            <TrashIcon />
            Delete message
          </button>
        </div>
      </div>

      <header className="card mb-5 p-4">
        <h1 data-testid="message-subject" className="break-words text-xl font-semibold sm:text-2xl">
          {message.subject || '(no subject)'}
        </h1>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-slate-500 dark:text-slate-400">From</dt>
          <dd className="min-w-0 break-words">{senderLabel(message.fromName, message.fromAddress)}</dd>
          <dt className="text-slate-500 dark:text-slate-400">To</dt>
          <dd className="min-w-0 break-words">{message.to}</dd>
          {message.cc ? (
            <>
              <dt className="text-slate-500 dark:text-slate-400">Cc</dt>
              <dd className="min-w-0 break-words">{message.cc}</dd>
            </>
          ) : null}
          {message.replyTo ? (
            <>
              <dt className="text-slate-500 dark:text-slate-400">Reply-To</dt>
              <dd className="min-w-0 break-words">{message.replyTo}</dd>
            </>
          ) : null}
          <dt className="text-slate-500 dark:text-slate-400">Received</dt>
          <dd>{formatDateTime(message.receivedAt)}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Mailbox</dt>
          <dd className="break-all font-mono text-xs sm:text-sm">{message.mailboxEmail}</dd>
        </dl>
      </header>

      <DetectedPanel message={message} />

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Message content">
        {tab === 'html' ? (
          hasHtml ? (
            <div className="space-y-3">
              <div className={`banner ${allowRemoteImages ? 'banner-warn' : 'banner-info'} items-center justify-between`}>
                <p>{allowRemoteImages ? 'Remote images are loading (the sender may see that you opened this).' : 'Remote images blocked (tracking protection)'}</p>
                <button type="button" className="btn btn-sm shrink-0" aria-pressed={allowRemoteImages} onClick={() => setAllowRemoteImages((v) => !v)}>
                  Load remote images
                </button>
              </div>
              <EmailFrame messageId={message.id} allowRemoteImages={allowRemoteImages} />
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">This message has no HTML part. See the Text tab.</p>
          )
        ) : null}
        {tab === 'text' ? (
          message.text ? (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-4 font-mono text-sm dark:border-slate-700 dark:bg-slate-900">{message.text}</pre>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">This message has no plain-text part.</p>
          )
        ) : null}
        {tab === 'headers' ? <HeadersTable headers={message.headers} /> : null}
        {tab === 'raw' ? <RawSource messageId={message.id} /> : null}
        {tab === 'attachments' ? <AttachmentsTable messageId={message.id} attachments={message.attachments} /> : null}
      </Tabs>
    </div>
  );
}
