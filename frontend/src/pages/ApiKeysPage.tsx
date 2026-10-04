import { useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { EmptyState, ErrorBanner, PageHeader, TableSkeleton } from '../components/ui';
import { useToast } from '../context/toast';
import { useQuery } from '../hooks/useQuery';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ApiKeyView } from '../lib/types';

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: ApiKeyView & { key: string }) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ref = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<ApiKeyView & { key: string }>('/api-keys', { name: name.trim() });
      onCreated(data);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title="Create API key" onClose={onClose} initialFocus={ref}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {error ? <ErrorBanner error={error} /> : null}
        <div>
          <label htmlFor="key-name" className="label">
            Key name
          </label>
          <input
            ref={ref}
            id="key-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="e.g. CI pipeline"
            autoComplete="off"
            required
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ApiKeysPage() {
  const toast = useToast();
  const list = useQuery('api-keys', async (signal) => (await api.get<ApiKeyView[]>('/api-keys', undefined, { signal })).data);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<(ApiKeyView & { key: string }) | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKeyView | null>(null);

  const keys = list.data ?? [];
  return (
    <div>
      <PageHeader title="API Keys" subtitle="Bearer tokens for scripts and CI. Send as Authorization: Bearer <key>.">
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Create API key
        </button>
      </PageHeader>

      {newKey ? (
        <section aria-labelledby="new-key-h" className="banner banner-success mb-5 flex-col">
          <h2 id="new-key-h" className="font-semibold">
            Your new API key
          </h2>
          <p className="font-medium">Copy it now. For security it cannot be shown again.</p>
          <div className="flex w-full flex-wrap items-center gap-2">
            <code data-testid="new-api-key" className="min-w-0 flex-1 break-all rounded-md bg-white/70 px-3 py-2 font-mono text-sm dark:bg-black/30">
              {newKey.key}
            </code>
            <CopyButton text={newKey.key} label="Copy key" ariaLabel="Copy API key" />
            <button type="button" className="btn btn-sm" onClick={() => setNewKey(null)}>
              Dismiss
            </button>
          </div>
        </section>
      ) : null}

      <div className="card overflow-hidden">
        {list.error && !list.data ? (
          <div className="p-4">
            <ErrorBanner error={list.error} title="Could not load API keys" onRetry={list.reload} />
          </div>
        ) : list.initialLoading ? (
          <TableSkeleton rows={3} />
        ) : keys.length === 0 ? (
          <EmptyState title="No API keys">Create a key to call the API from scripts without a browser session.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem]">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="th">Name</th>
                  <th scope="col" className="th">Key</th>
                  <th scope="col" className="th">Created</th>
                  <th scope="col" className="th">Last used</th>
                  <th scope="col" className="th">Status</th>
                  <th scope="col" className="th">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} data-testid="api-key-row" className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
                    <td className="td break-words font-medium">{k.name}</td>
                    <td className="td font-mono text-xs">{k.keyPrefix}…</td>
                    <td className="td whitespace-nowrap text-xs">{formatDateTime(k.createdAt)}</td>
                    <td className="td whitespace-nowrap text-xs">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : 'Never'}</td>
                    <td className="td">{k.revokedAt ? <span className="badge badge-red">Revoked</span> : <span className="badge badge-green">Active</span>}</td>
                    <td className="td text-right">
                      {k.revokedAt ? null : (
                        <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => setToRevoke(k)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating ? (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setNewKey(key);
            list.reload();
          }}
        />
      ) : null}

      {toRevoke ? (
        <ConfirmDialog
          title="Revoke API key?"
          onCancel={() => setToRevoke(null)}
          onConfirm={async () => {
            await api.delete(`/api-keys/${toRevoke.id}`);
            setToRevoke(null);
            toast.push({ message: `Revoked "${toRevoke.name}"`, kind: 'success' });
            list.reload();
          }}
        >
          <p>
            Anything using <span className="font-medium">{toRevoke.name}</span> will immediately lose access. This cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
