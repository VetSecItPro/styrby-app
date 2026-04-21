'use client';

import { useState } from 'react';
import { SignOutDialog } from './sign-out-dialog';
import { DeleteAccountDialog } from './delete-account-dialog';

/**
 * Danger Zone: sign-out button and delete-account button, each with their
 * own confirmation dialog.
 *
 * WHY the dialogs are owned here (not in the orchestrator): both dialogs are
 * trigger-owned — only this section opens them, so keeping the open/close
 * state local reduces orchestrator re-renders when the user opens a dialog.
 */
export function SettingsDangerZone() {
  const [showSignOut, setShowSignOut] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  return (
    <>
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-red-400 mb-4">Danger Zone</h2>
        <div className="rounded-xl bg-zinc-900 border border-red-500/30 divide-y divide-red-500/10">
          <div className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Sign Out</p>
                <p className="text-sm text-zinc-500">
                  Sign out of your account on this device
                </p>
              </div>
              <button
                onClick={() => setShowSignOut(true)}
                className="rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                aria-label="Sign out of account"
              >
                Sign Out
              </button>
            </div>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Delete Account</p>
                <p className="text-sm text-zinc-500">
                  Permanently delete your account and all data
                </p>
              </div>
              <div className="relative group">
                <button
                  onClick={() => setShowDelete(true)}
                  className="rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                  aria-label="Delete account"
                >
                  Delete Account
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SignOutDialog open={showSignOut} onClose={() => setShowSignOut(false)} />
      <DeleteAccountDialog open={showDelete} onClose={() => setShowDelete(false)} />
    </>
  );
}
