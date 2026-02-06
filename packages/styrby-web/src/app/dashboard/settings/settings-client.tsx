'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { ThemeToggle } from '@/components/theme-toggle';

/* ──────────────────────────── Types ──────────────────────────── */

interface Profile {
  id: string;
  display_name: string | null;
  [key: string]: unknown;
}

interface Subscription {
  tier: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  [key: string]: unknown;
}

interface NotificationPrefs {
  push_enabled: boolean;
  email_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  priority_threshold?: number;
  [key: string]: unknown;
}

interface AgentConfig {
  agent_type: string;
  auto_approve_low_risk: boolean;
  [key: string]: unknown;
}

interface UserData {
  email: string;
  provider: string | undefined;
}

interface SettingsClientProps {
  /** Authenticated user data (email, provider) */
  user: UserData;
  /** User profile row from the profiles table */
  profile: Profile | null;
  /** Active subscription, if any */
  subscription: Subscription | null;
  /** Notification preferences for the user */
  notificationPrefs: NotificationPrefs | null;
  /** Per-agent configuration rows */
  agentConfigs: AgentConfig[] | null;
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Client-side interactive settings panel.
 * Handles sign-out, email change, name editing, password reset,
 * notification toggles, and the delete-account danger zone.
 *
 * @param props - Pre-fetched data from the server component
 */
export function SettingsClient({
  user,
  profile,
  subscription,
  notificationPrefs,
  agentConfigs,
}: SettingsClientProps) {
  const router = useRouter();
  const supabase = createClient();

  /* ── Local state ─────────────────────────────────────────────── */

  // Sign-out
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Email change
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailMessage, setEmailMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Display name editing
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMessage, setNameMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Password change
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Delete account
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Data export
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMessage, setExportMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Notification toggles
  const [pushEnabled, setPushEnabled] = useState(
    notificationPrefs?.push_enabled ?? true
  );
  const [emailEnabled, setEmailEnabled] = useState(
    notificationPrefs?.email_enabled ?? true
  );
  const [notifSaving, setNotifSaving] = useState(false);

  // Priority threshold for smart notifications (1-5 scale)
  const [priorityThreshold, setPriorityThreshold] = useState(
    notificationPrefs?.priority_threshold ?? 3
  );
  const [prioritySaving, setPrioritySaving] = useState(false);

  /** Whether the user is on a paid tier (Pro+ enables smart notifications) */
  const isPaidTier = subscription?.tier === 'pro' || subscription?.tier === 'power';

  /* ── Handlers ────────────────────────────────────────────────── */

  /**
   * Signs the user out and redirects to /login.
   */
  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.push('/login');
  }, [supabase, router]);

  /**
   * Sends Supabase a request to update the user's email.
   * Supabase will send a confirmation link to the new address.
   */
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

  /**
   * Saves an updated display name to the profiles table.
   */
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

  /**
   * Sends a password reset email via Supabase.
   */
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

  /**
   * Exports all user data as a JSON file download (GDPR compliance).
   */
  const handleExportData = useCallback(async () => {
    setExportLoading(true);
    setExportMessage(null);

    try {
      const response = await fetch('/api/account/export', {
        method: 'POST',
      });

      if (response.status === 429) {
        const data = await response.json();
        setExportMessage({
          type: 'error',
          text: `Rate limited. Try again in ${Math.ceil(data.retryAfter / 60)} minutes.`,
        });
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        setExportMessage({
          type: 'error',
          text: data.error || 'Failed to export data',
        });
        return;
      }

      // Trigger file download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
        'styrby-data-export.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportMessage({
        type: 'success',
        text: 'Your data has been downloaded.',
      });
    } catch {
      setExportMessage({
        type: 'error',
        text: 'Failed to export data. Please try again.',
      });
    } finally {
      setExportLoading(false);
    }
  }, []);

  /**
   * Initiates account deletion via the API endpoint.
   * Requires exact confirmation text "DELETE MY ACCOUNT".
   */
  const handleDeleteAccount = useCallback(async () => {
    if (deleteConfirmText !== 'DELETE MY ACCOUNT') return;

    setDeleteLoading(true);
    setDeleteError(null);

    try {
      const response = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'DELETE MY ACCOUNT',
          reason: deleteReason || undefined,
        }),
      });

      if (response.status === 429) {
        const data = await response.json();
        setDeleteError(
          `Rate limited. Try again in ${Math.ceil(data.retryAfter / 3600)} hours.`
        );
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        setDeleteError(data.error || 'Failed to delete account');
        return;
      }

      // Redirect to login after successful deletion
      router.push('/login?deleted=true');
    } catch {
      setDeleteError('Failed to delete account. Please try again.');
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteConfirmText, deleteReason, router]);

  /**
   * Toggles a notification preference (push or email) and persists it.
   */
  const handleNotificationToggle = useCallback(
    async (field: 'push_enabled' | 'email_enabled', value: boolean) => {
      if (field === 'push_enabled') setPushEnabled(value);
      else setEmailEnabled(value);

      setNotifSaving(true);
      await supabase
        .from('notification_preferences')
        .upsert(
          {
            user_id: profile?.id,
            [field]: value,
          },
          { onConflict: 'user_id' }
        );
      setNotifSaving(false);
    },
    [supabase, profile?.id]
  );

  /**
   * Updates the notification priority threshold for smart filtering.
   * Priority threshold: 1 = Urgent only, 5 = All notifications
   */
  const handlePriorityChange = useCallback(
    async (value: number) => {
      setPriorityThreshold(value);
      setPrioritySaving(true);

      await supabase
        .from('notification_preferences')
        .upsert(
          {
            user_id: profile?.id,
            priority_threshold: value,
          },
          { onConflict: 'user_id' }
        );
      setPrioritySaving(false);
    },
    [supabase, profile?.id]
  );

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <>
      {/* Account Section */}
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

            {/* Inline email change form */}
            {showEmailDialog && (
              <div className="mt-4 p-4 rounded-lg bg-zinc-800/50 border border-zinc-700 space-y-3">
                <label
                  htmlFor="new-email"
                  className="block text-sm font-medium text-zinc-300"
                >
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
                      emailMessage.type === 'success'
                        ? 'text-green-400'
                        : 'text-red-400'
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
                <p className="text-sm font-medium text-zinc-100">
                  Display Name
                </p>
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
                  nameMessage.type === 'success'
                    ? 'text-green-400'
                    : 'text-red-400'
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
                  onClick={() =>
                    setShowPasswordDialog(!showPasswordDialog)
                  }
                  className="text-sm text-orange-500 hover:text-orange-400"
                  aria-label="Change password"
                >
                  Change
                </button>
              )}
            </div>

            {/* Inline password reset */}
            {showPasswordDialog && (
              <div className="mt-4 p-4 rounded-lg bg-zinc-800/50 border border-zinc-700 space-y-3">
                <p className="text-sm text-zinc-300">
                  We will send a password reset link to{' '}
                  <span className="font-medium text-zinc-100">
                    {user.email}
                  </span>
                  .
                </p>
                {passwordMessage && (
                  <p
                    className={`text-sm ${
                      passwordMessage.type === 'success'
                        ? 'text-green-400'
                        : 'text-red-400'
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
        </div>
      </section>

      {/* Subscription Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Subscription
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold text-zinc-100 capitalize">
                  {subscription?.tier || 'Free'} Plan
                </p>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    subscription?.status === 'active'
                      ? 'bg-green-500/10 text-green-400'
                      : subscription?.status === 'trialing'
                        ? 'bg-blue-500/10 text-blue-400'
                        : 'bg-zinc-700 text-zinc-400'
                  }`}
                >
                  {subscription?.status || 'Free'}
                </span>
              </div>
              {subscription?.current_period_end && (
                <p className="text-sm text-zinc-500 mt-1">
                  {subscription.cancel_at_period_end ? 'Cancels' : 'Renews'} on{' '}
                  {new Date(
                    subscription.current_period_end
                  ).toLocaleDateString()}
                </p>
              )}
            </div>
            <button
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              aria-label={
                subscription?.tier === 'free' || !subscription
                  ? 'Upgrade subscription'
                  : 'Manage subscription'
              }
            >
              {subscription?.tier === 'free' || !subscription
                ? 'Upgrade'
                : 'Manage'}
            </button>
          </div>

          {/* Usage */}
          {subscription && subscription.tier !== 'free' && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <p className="text-sm text-zinc-500">
                This month&apos;s usage: $12.45 / $50.00 included
              </p>
              <div className="mt-2 h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full"
                  style={{ width: '24.9%' }}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Appearance Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 dark:text-zinc-100 mb-4">
          Appearance
        </h2>
        <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Theme
              </p>
              <p className="text-sm text-zinc-500 dark:text-zinc-500">
                Choose your preferred color scheme
              </p>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* Notifications Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 dark:text-zinc-100 mb-4">
          Notifications
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          {/* Push notifications */}
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">
                Push Notifications
              </p>
              <p className="text-sm text-zinc-500">
                Get notified when agents need attention
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={pushEnabled}
                onChange={(e) =>
                  handleNotificationToggle('push_enabled', e.target.checked)
                }
                disabled={notifSaving}
                aria-label="Toggle push notifications"
              />
              <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Email notifications */}
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">
                Email Notifications
              </p>
              <p className="text-sm text-zinc-500">
                Weekly summary and important alerts
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={emailEnabled}
                onChange={(e) =>
                  handleNotificationToggle('email_enabled', e.target.checked)
                }
                disabled={notifSaving}
                aria-label="Toggle email notifications"
              />
              <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Quiet hours */}
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Quiet Hours</p>
              <p className="text-sm text-zinc-500">
                {notificationPrefs?.quiet_hours_start &&
                notificationPrefs?.quiet_hours_end
                  ? `${notificationPrefs.quiet_hours_start} - ${notificationPrefs.quiet_hours_end}`
                  : 'Not configured'}
              </p>
            </div>
            <button
              className="text-sm text-orange-500 hover:text-orange-400"
              aria-label="Configure quiet hours"
            >
              Configure
            </button>
          </div>

          {/* Smart Notifications Priority */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">
                    Notification Sensitivity
                  </p>
                  {!isPaidTier && (
                    <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400">
                      Pro
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-500">
                  Filter notifications by importance
                </p>
              </div>
              {prioritySaving && (
                <span className="text-xs text-zinc-500">Saving...</span>
              )}
            </div>

            {/* Priority Slider */}
            <div className={`${!isPaidTier ? 'opacity-50 pointer-events-none' : ''}`}>
              <input
                type="range"
                min="1"
                max="5"
                value={priorityThreshold}
                onChange={(e) => handlePriorityChange(parseInt(e.target.value, 10))}
                disabled={!isPaidTier || prioritySaving}
                className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700 accent-orange-500"
                aria-label="Notification sensitivity slider"
              />
              <div className="flex justify-between mt-2">
                <span className="text-xs text-zinc-500">Urgent only</span>
                <span className="text-xs text-zinc-500">All</span>
              </div>

              {/* Current level description */}
              <div className="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
                <p className="text-sm font-medium text-zinc-100 mb-1">
                  {priorityThreshold === 1 && 'Urgent only'}
                  {priorityThreshold === 2 && 'High priority'}
                  {priorityThreshold === 3 && 'Medium priority'}
                  {priorityThreshold === 4 && 'Most notifications'}
                  {priorityThreshold === 5 && 'All notifications'}
                </p>
                <p className="text-xs text-zinc-400 mb-2">
                  {priorityThreshold === 1 &&
                    "You'll receive ~5% of notifications. Only critical alerts like budget exceeded and high-risk permission requests."}
                  {priorityThreshold === 2 &&
                    "You'll receive ~15% of notifications. Includes budget warnings, session errors, and permission requests."}
                  {priorityThreshold === 3 &&
                    "You'll receive ~50% of notifications. Balanced filtering for moderate importance."}
                  {priorityThreshold === 4 &&
                    "You'll receive ~85% of notifications. Most notifications except purely informational ones."}
                  {priorityThreshold === 5 &&
                    "You'll receive all notifications. No filtering applied."}
                </p>
                <div className="space-y-1 text-xs text-zinc-500">
                  <p className="font-medium text-zinc-400">Examples at this level:</p>
                  {priorityThreshold >= 1 && (
                    <p>- Budget exceeded alerts, dangerous tool permissions (bash, delete)</p>
                  )}
                  {priorityThreshold >= 2 && (
                    <p>- Budget warnings, session errors, medium-risk operations</p>
                  )}
                  {priorityThreshold >= 3 && (
                    <p>- Session completions with significant cost (&gt;$5)</p>
                  )}
                  {priorityThreshold >= 4 && (
                    <p>- Low-cost session completions, long session summaries</p>
                  )}
                  {priorityThreshold >= 5 && (
                    <p>- Session started, all informational updates</p>
                  )}
                </div>
              </div>
            </div>

            {/* Pro upgrade CTA for free users */}
            {!isPaidTier && (
              <div className="mt-4 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
                <p className="text-sm text-orange-400 mb-2">
                  Smart notifications help reduce notification fatigue by filtering based on importance.
                </p>
                <button className="text-sm font-medium text-orange-500 hover:text-orange-400">
                  Upgrade to Pro to enable
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Agent Settings Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Agent Settings
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          {['claude', 'codex', 'gemini'].map((agent) => {
            const config = agentConfigs?.find((c) => c.agent_type === agent);
            return (
              <div
                key={agent}
                className="px-4 py-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                      agent === 'claude'
                        ? 'bg-orange-500/10'
                        : agent === 'codex'
                          ? 'bg-green-500/10'
                          : 'bg-blue-500/10'
                    }`}
                  >
                    <span
                      className={`text-sm font-bold ${
                        agent === 'claude'
                          ? 'text-orange-400'
                          : agent === 'codex'
                            ? 'text-green-400'
                            : 'text-blue-400'
                      }`}
                    >
                      {agent[0].toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-zinc-100 capitalize">
                      {agent}
                    </p>
                    <p className="text-sm text-zinc-500">
                      {config?.auto_approve_low_risk
                        ? 'Auto-approve low risk'
                        : 'Manual approval'}
                    </p>
                  </div>
                </div>
                <button
                  className="text-sm text-orange-500 hover:text-orange-400"
                  aria-label={`Configure ${agent} agent`}
                >
                  Configure
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Integrations Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Integrations
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          {/* API Keys */}
          <Link
            href="/dashboard/settings/api"
            className="px-4 py-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                <svg
                  className="h-4 w-4 text-orange-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">API Keys</p>
                  <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400">
                    Power
                  </span>
                </div>
                <p className="text-sm text-zinc-500">
                  Access your data programmatically
                </p>
              </div>
            </div>
            <svg
              className="h-5 w-5 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </Link>

          {/* Webhooks */}
          <Link
            href="/dashboard/settings/webhooks"
            className="px-4 py-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                <svg
                  className="h-4 w-4 text-purple-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-100">Webhooks</p>
                <p className="text-sm text-zinc-500">
                  Send events to Slack, Discord, or custom endpoints
                </p>
              </div>
            </div>
            <svg
              className="h-5 w-5 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </Link>

          {/* Templates */}
          <Link
            href="/dashboard/settings/templates"
            className="px-4 py-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <svg
                  className="h-4 w-4 text-cyan-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-100">Prompt Templates</p>
                <p className="text-sm text-zinc-500">
                  Reusable prompts for common tasks
                </p>
              </div>
            </div>
            <svg
              className="h-5 w-5 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </Link>
        </div>
      </section>

      {/* Data & Privacy Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Data & Privacy
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          {/* Export Data */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Export Your Data</p>
                <p className="text-sm text-zinc-500">
                  Download all your data in JSON format (GDPR)
                </p>
              </div>
              <button
                onClick={handleExportData}
                disabled={exportLoading}
                className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Export your data"
              >
                {exportLoading ? 'Exporting...' : 'Export Data'}
              </button>
            </div>
            {exportMessage && (
              <p
                className={`mt-2 text-sm ${
                  exportMessage.type === 'success'
                    ? 'text-green-400'
                    : 'text-red-400'
                }`}
              >
                {exportMessage.text}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Danger Zone */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-red-400 mb-4">
          Danger Zone
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-red-500/30 divide-y divide-red-500/10">
          {/* Sign Out */}
          <div className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Sign Out</p>
                <p className="text-sm text-zinc-500">
                  Sign out of your account on this device
                </p>
              </div>
              <button
                onClick={() => setShowSignOutDialog(true)}
                className="rounded-lg border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                aria-label="Sign out of account"
              >
                Sign Out
              </button>
            </div>
          </div>

          {/* Delete Account */}
          <div className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">
                  Delete Account
                </p>
                <p className="text-sm text-zinc-500">
                  Permanently delete your account and all data
                </p>
              </div>
              <div className="relative group">
                <button
                  onClick={() => setShowDeleteDialog(true)}
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

      {/* ── Sign Out Confirmation Dialog ──────────────────────── */}
      {showSignOutDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="signout-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl">
            <h3
              id="signout-title"
              className="text-lg font-semibold text-zinc-100 mb-2"
            >
              Sign out?
            </h3>
            <p className="text-sm text-zinc-400 mb-6">
              You will be signed out of Styrby on this device. You can sign back
              in at any time.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSignOutDialog(false)}
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
      )}

      {/* ── Delete Account Confirmation Dialog ───────────────── */}
      {showDeleteDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700 p-6 shadow-xl">
            <h3
              id="delete-title"
              className="text-lg font-semibold text-red-400 mb-2"
            >
              Delete your account?
            </h3>
            <p className="text-sm text-zinc-400 mb-4">
              This will schedule your account for deletion. Your data will be
              permanently removed in 30 days, allowing time for recovery if
              you change your mind.
            </p>
            <p className="text-sm text-zinc-400 mb-3">
              Type{' '}
              <span className="font-mono font-bold text-red-400">
                DELETE MY ACCOUNT
              </span>{' '}
              to confirm:
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Type DELETE MY ACCOUNT"
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 mb-4"
              aria-label="Type DELETE MY ACCOUNT to confirm account deletion"
            />
            <label className="block text-sm text-zinc-400 mb-2">
              Why are you leaving? (optional)
            </label>
            <textarea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Help us improve..."
              rows={2}
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 mb-4 resize-none"
              aria-label="Reason for leaving (optional)"
            />
            {deleteError && (
              <p className="text-sm text-red-400 mb-4">{deleteError}</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmText('');
                  setDeleteReason('');
                  setDeleteError(null);
                }}
                disabled={deleteLoading}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                disabled={deleteConfirmText !== 'DELETE MY ACCOUNT' || deleteLoading}
                onClick={handleDeleteAccount}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleteLoading ? 'Deleting...' : 'Delete My Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
