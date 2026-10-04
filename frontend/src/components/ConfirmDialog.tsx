import { useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { ErrorBanner } from './ui';

/**
 * Destructive confirmation. The confirm button is always named exactly "Confirm delete";
 * focus starts on "Cancel" so a stray Enter never deletes anything.
 */
export function ConfirmDialog({
  title,
  children,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={() => (busy ? undefined : onCancel())} initialFocus={cancelRef}>
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">{children}</div>
      {error ? (
        <div className="mt-3">
          <ErrorBanner error={error} />
        </div>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy} aria-busy={busy}>
          Confirm delete
        </button>
      </div>
    </Modal>
  );
}
