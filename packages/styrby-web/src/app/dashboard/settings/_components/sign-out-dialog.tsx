'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/** Props for the SignOutDialog. */
export interface SignOutDialogProps {
  /** Whether the dialog is currently open. */
  open: boolean;
  /** Callback invoked when the user dismisses the dialog without signing out. */
  onClose: () => void;
}

/**
 * Confirmation dialog for signing out. Owns its own in-flight state so the
 * button can show "Signing out..." without the parent re-rendering the whole
 * Danger Zone section.
 */
export function SignOutDialog({ open, onClose }: SignOutDialogProps) {
  const router = useRouter();
  const supabase = createClient();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.push('/login');
  }, [supabase, router]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signout-title"
    >
      <div className="w-full md:w-auto md:min-w-[28rem] max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl">
        <h3 id="signout-title" className="text-lg font-semibold text-zinc-100 mb-2">
          Sign out?
        </h3>
        <p className="text-sm text-zinc-400 mb-6">
          You will be signed out of Styrby on this device. You can sign back in at any
          time.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {signingOut ? 'Signing out...' : 'Sign Out'}
          </button>
        </div>
      </div>
    </div>
  );
}
