'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

/** The exact phrase the user must type to confirm irreversible account deletion. */
const CONFIRM_PHRASE = 'DELETE MY ACCOUNT';

/** Props for the DeleteAccountDialog. */
export interface DeleteAccountDialogProps {
  /** Whether the dialog is currently open. */
  open: boolean;
  /** Callback invoked when the user dismisses the dialog. */
  onClose: () => void;
}

/**
 * Confirmation dialog for deleting the user's account. Requires exact
 * phrase match before enabling the red button. Submits to /api/account/delete,
 * honors rate-limit responses, and routes to /login?deleted=true on success
 * (server schedules 30-day delayed purge).
 *
 * WHY an exact phrase: This is a permanent action at the end of a 30-day
 * recovery window. The phrase match prevents reflexive dismiss-confirm
 * mistakes — a clear, explicit opt-in is required by GDPR erasure UX
 * guidance.
 */
export function DeleteAccountDialog({ open, onClose }: DeleteAccountDialogProps) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    if (confirmText !== CONFIRM_PHRASE) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: CONFIRM_PHRASE,
          reason: reason || undefined,
        }),
      });
      if (response.status === 429) {
        const data = await response.json();
        setError(
          `Rate limited. Try again in ${Math.ceil(data.retryAfter / 3600)} hours.`
        );
        return;
      }
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Failed to delete account');
        return;
      }
      router.push('/login?deleted=true');
    } catch {
      setError('Failed to delete account. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [confirmText, reason, router]);

  const handleClose = () => {
    setConfirmText('');
    setReason('');
    setError(null);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
    >
      <div className="w-full md:w-auto md:min-w-[28rem] max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl">
        <h3 id="delete-title" className="text-lg font-semibold text-red-400 mb-2">
          Delete your account?
        </h3>
        <p className="text-sm text-zinc-400 mb-4">
          This will schedule your account for deletion. Your data will be permanently
          removed in 30 days, allowing time for recovery if you change your mind.
        </p>
        <p className="text-sm text-zinc-400 mb-3">
          Type{' '}
          <span className="font-mono font-bold text-red-400">{CONFIRM_PHRASE}</span> to
          confirm:
        </p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={`Type ${CONFIRM_PHRASE}`}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 mb-4"
          aria-label={`Type ${CONFIRM_PHRASE} to confirm account deletion`}
        />
        <label className="block text-sm text-zinc-400 mb-2">
          Why are you leaving? (optional)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Help us improve..."
          rows={2}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 mb-4 resize-none"
          aria-label="Reason for leaving (optional)"
        />
        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            onClick={handleClose}
            disabled={loading}
            className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={confirmText !== CONFIRM_PHRASE || loading}
            onClick={handleDelete}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Deleting...' : 'Delete My Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
