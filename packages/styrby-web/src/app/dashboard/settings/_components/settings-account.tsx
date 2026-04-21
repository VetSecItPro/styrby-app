'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { SettingsLinkRow } from './settings-link-row';
import type { InlineMessage, Profile, UserData } from './types';

/**
 * Props for the account settings section.
 *
 * All state is owned locally per-section (email form, name edit, password
 * reset). The parent orchestrator only provides read-only data so the parent
 * doesn't balloon back into a god-component.
 */
export interface SettingsAccountProps {
  /** Authenticated user (email, provider). */
  user: UserData;
  /** User profile row from the profiles table (nullable — trigger may lag briefly). */
  profile: Profile | null;
}

/**
 * Account section: email change, display-name editing, password reset,
 * passkey management link.
 *
 * WHY router.refresh() after name update: Next.js server components re-fetch
 * the profile row so subsequent server-rendered sections (e.g., nav header
 * welcome message) reflect the new display name. Omitting it leaves the UI
 * stale until the next navigation.
 */
export function SettingsAccount({ user, profile }: SettingsAccountProps) {
  const router = useRouter();
  const supabase = createClient();

  // Email change
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailMessage, setEmailMessage] = useState<InlineMessage>(null);

  // Display name
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMessage, setNameMessage] = useState<InlineMessage>(null);

  // Password
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<InlineMessage>(null);

  /** Sends Supabase a request to update the user's email; triggers a confirmation link. */
  const handleEmailChange = useCallback(async () => {
    if (!newEmail.trim()) return;
    setEmailLoading(true);
    setEmailMessage(null);
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    if (error) {
      setEmailMessage({ type: 'error', text: error.message });
    } else {
      setEmailMessage({
        type: 'success',
        text: 'Confirmation sent to your new email address. Check your inbox.',
      });
      setNewEmail('');
    }
    setEmailLoading(false);
  }, [supabase, newEmail]);

  /** Saves an updated display name to the profiles table. */
  const handleNameSave = useCallback(async () => {
    if (!profile) return;
    setNameSaving(true);
    setNameMessage(null);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName.trim() || null })
      .eq('id', profile.id);
    if (error) {
      setNameMessage({ type: 'error', text: error.message });
    } else {
      setNameMessage({ type: 'success', text: 'Display name updated.' });
      setEditingName(false);
      router.refresh();
    }
    setNameSaving(false);
  }, [supabase, profile, displayName, router]);

  /** Sends a password reset email via Supabase. */
  const handlePasswordReset = useCallback(async () => {
    if (!user.email) return;
    setPasswordLoading(true);
    setPasswordMessage(null);
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}/auth/callback?redirect=/settings`,
    });
    if (error) {
      setPasswordMessage({ type: 'error', text: error.message });
    } else {
      setPasswordMessage({
        type: 'success',
        text: 'Password reset link sent to your email.',
      });
    }
    setPasswordLoading(false);
  }, [supabase, user.email]);

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Account</h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
        {/* Email */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Email</p>
              <p className="text-sm text-zinc-500">{user.email}</p>
            </div>
            <button
              onClick={() => setShowEmailDialog(!showEmailDialog)}
              className="text-sm text-orange-500 hover:text-orange-400"
              aria-label="Change email address"
            >
              Change
            </button>
          </div>
          {showEmailDialog && (
            <div className="mt-4 p-4 rounded-lg bg-zinc-800/50 border border-zinc-700 space-y-3">
              <label htmlFor="new-email" className="block text-sm font-medium text-zinc-300">
                New email address
              </label>
              <input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="new@example.com"
                className="w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
              {emailMessage && (
                <p
                  className={`text-sm ${
                    emailMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {emailMessage.text}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleEmailChange}
                  disabled={emailLoading || !newEmail.trim()}
                  className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {emailLoading ? 'Sending...' : 'Send confirmation'}
                </button>
                <button
                  onClick={() => {
                    setShowEmailDialog(false);
                    setEmailMessage(null);
                    setNewEmail('');
                  }}
                  className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Display name */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Display Name</p>
              {editingName ? (
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoFocus
                  className="mt-1 w-60 rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  placeholder="Enter display name"
                  aria-label="Display name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNameSave();
                    if (e.key === 'Escape') {
                      setEditingName(false);
                      setDisplayName(profile?.display_name || '');
                      setNameMessage(null);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-zinc-500">
                  {profile?.display_name || 'Not set'}
                </p>
              )}
            </div>
            {editingName ? (
              <div className="flex gap-2">
                <button
                  onClick={handleNameSave}
                  disabled={nameSaving}
                  className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Save display name"
                >
                  {nameSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditingName(false);
                    setDisplayName(profile?.display_name || '');
                    setNameMessage(null);
                  }}
                  className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                  aria-label="Cancel editing display name"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingName(true)}
                className="text-sm text-orange-500 hover:text-orange-400"
                aria-label="Edit display name"
              >
                Edit
              </button>
            )}
          </div>
          {nameMessage && (
            <p
              className={`mt-2 text-sm ${
                nameMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {nameMessage.text}
            </p>
          )}
        </div>

        {/* Password */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Password</p>
              <p className="text-sm text-zinc-500">
                {user.provider === 'github'
                  ? 'Signed in with GitHub'
                  : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
              </p>
            </div>
            {user.provider !== 'github' && (
              <button
                onClick={() => setShowPasswordDialog(!showPasswordDialog)}
                className="text-sm text-orange-500 hover:text-orange-400"
                aria-label="Change password"
              >
                Change
              </button>
            )}
          </div>
          {showPasswordDialog && (
            <div className="mt-4 p-4 rounded-lg bg-zinc-800/50 border border-zinc-700 space-y-3">
              <p className="text-sm text-zinc-300">
                We will send a password reset link to{' '}
                <span className="font-medium text-zinc-100">{user.email}</span>.
              </p>
              {passwordMessage && (
                <p
                  className={`text-sm ${
                    passwordMessage.type === 'success' ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {passwordMessage.text}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handlePasswordReset}
                  disabled={passwordLoading}
                  className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {passwordLoading ? 'Sending...' : 'Send reset link'}
                </button>
                <button
                  onClick={() => {
                    setShowPasswordDialog(false);
                    setPasswordMessage(null);
                  }}
                  className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Passkeys link */}
        {/* WHY a link vs inline: Passkey list/enroll/revoke/rename warrants its own
            page. Inlining would bloat SettingsClient past the 400-line limit. */}
        <SettingsLinkRow
          href="/dashboard/settings/account/passkeys"
          label="Passkeys"
          description="Sign in with Face ID, Touch ID, or your device PIN"
          ariaLabel="Manage passkeys"
        />
      </div>
    </section>
  );
}
