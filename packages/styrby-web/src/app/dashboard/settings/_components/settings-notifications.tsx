'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useWebPush } from './use-web-push';
import type { NotificationPrefs, Profile, Subscription } from './types';

/** Props for the Notifications section. */
export interface SettingsNotificationsProps {
  /** Owning profile (used as user_id in upserts). */
  profile: Profile | null;
  /** Current notification preferences row. */
  notificationPrefs: NotificationPrefs | null;
  /** Active subscription — gates the smart-priority slider to paid tiers. */
  subscription: Subscription | null;
}

/**
 * Description strings keyed by priority threshold (1 = Urgent only, 5 = All).
 *
 * WHY a map vs inline conditionals: the original 1,717-LOC file had four
 * parallel `priorityThreshold === N` ternaries per line; that's four bug
 * surfaces that must stay in sync. A single map is the single source of
 * truth.
 */
const PRIORITY_COPY: Record<
  number,
  { title: string; summary: string; examples: string[] }
> = {
  1: {
    title: 'Urgent only',
    summary:
      "You'll receive ~5% of notifications. Only critical alerts like budget exceeded and high-risk permission requests.",
    examples: [
      '- Budget exceeded alerts, dangerous tool permissions (bash, delete)',
    ],
  },
  2: {
    title: 'High priority',
    summary:
      "You'll receive ~15% of notifications. Includes budget warnings, session errors, and permission requests.",
    examples: [
      '- Budget exceeded alerts, dangerous tool permissions (bash, delete)',
      '- Budget warnings, session errors, medium-risk operations',
    ],
  },
  3: {
    title: 'Medium priority',
    summary:
      "You'll receive ~50% of notifications. Balanced filtering for moderate importance.",
    examples: [
      '- Budget exceeded alerts, dangerous tool permissions (bash, delete)',
      '- Budget warnings, session errors, medium-risk operations',
      '- Session completions with significant cost (>$5)',
    ],
  },
  4: {
    title: 'Most notifications',
    summary:
      "You'll receive ~85% of notifications. Most notifications except purely informational ones.",
    examples: [
      '- Budget exceeded alerts, dangerous tool permissions (bash, delete)',
      '- Budget warnings, session errors, medium-risk operations',
      '- Session completions with significant cost (>$5)',
      '- Low-cost session completions, long session summaries',
    ],
  },
  5: {
    title: 'All notifications',
    summary: "You'll receive all notifications. No filtering applied.",
    examples: [
      '- Budget exceeded alerts, dangerous tool permissions (bash, delete)',
      '- Budget warnings, session errors, medium-risk operations',
      '- Session completions with significant cost (>$5)',
      '- Low-cost session completions, long session summaries',
      '- Session started, all informational updates',
    ],
  },
};

/**
 * Notifications section: push/email toggles, browser Web Push subscription,
 * quiet hours, and the Pro-tier smart-priority sensitivity slider.
 */
export function SettingsNotifications({
  profile,
  notificationPrefs,
  subscription,
}: SettingsNotificationsProps) {
  const router = useRouter();
  const supabase = createClient();

  const isPaidTier = subscription?.tier === 'pro' || subscription?.tier === 'growth';

  const [pushEnabled, setPushEnabled] = useState(
    notificationPrefs?.push_enabled ?? true
  );
  const [emailEnabled, setEmailEnabled] = useState(
    notificationPrefs?.email_enabled ?? true
  );
  const [notifSaving, setNotifSaving] = useState(false);

  const [editingQuietHours, setEditingQuietHours] = useState(false);
  const [quietStart, setQuietStart] = useState(
    notificationPrefs?.quiet_hours_start || '22:00'
  );
  const [quietEnd, setQuietEnd] = useState(
    notificationPrefs?.quiet_hours_end || '07:00'
  );
  const [quietHoursSaving, setQuietHoursSaving] = useState(false);

  const [priorityThreshold, setPriorityThreshold] = useState(
    notificationPrefs?.priority_threshold ?? 3
  );
  const [prioritySaving, setPrioritySaving] = useState(false);

  const webPush = useWebPush();

  /** Toggle a notification preference (push or email) and persist it. */
  const handleNotificationToggle = useCallback(
    async (field: 'push_enabled' | 'email_enabled', value: boolean) => {
      if (field === 'push_enabled') setPushEnabled(value);
      else setEmailEnabled(value);
      setNotifSaving(true);
      await supabase
        .from('notification_preferences')
        .upsert({ user_id: profile?.id, [field]: value }, { onConflict: 'user_id' });
      setNotifSaving(false);
    },
    [supabase, profile?.id]
  );

  /** Update the priority threshold (1..5) for smart notification filtering. */
  const handlePriorityChange = useCallback(
    async (value: number) => {
      setPriorityThreshold(value);
      setPrioritySaving(true);
      await supabase
        .from('notification_preferences')
        .upsert(
          { user_id: profile?.id, priority_threshold: value },
          { onConflict: 'user_id' }
        );
      setPrioritySaving(false);
    },
    [supabase, profile?.id]
  );

  /**
   * Persist quiet hours.
   *
   * WHY HH:MM strings (not timestamps): timezone conversion happens at
   * delivery time so the user's "do not disturb after 10pm" keeps meaning
   * 10pm local even after travel.
   */
  const handleQuietHoursSave = useCallback(async () => {
    setQuietHoursSaving(true);
    await supabase
      .from('notification_preferences')
      .upsert(
        {
          user_id: profile?.id,
          quiet_hours_start: quietStart,
          quiet_hours_end: quietEnd,
        },
        { onConflict: 'user_id' }
      );
    setQuietHoursSaving(false);
    setEditingQuietHours(false);
    router.refresh();
  }, [supabase, profile?.id, quietStart, quietEnd, router]);

  const priorityCopy = PRIORITY_COPY[priorityThreshold] ?? PRIORITY_COPY[3];

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 dark:text-zinc-100 mb-4">
        Notifications
      </h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
        {/* Push toggle */}
        <div className="px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-100">Push Notifications</p>
            <p className="text-sm text-zinc-500">
              Get notified when agents need attention
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={pushEnabled}
              onChange={(e) => handleNotificationToggle('push_enabled', e.target.checked)}
              disabled={notifSaving}
              aria-label="Toggle push notifications"
            />
            <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
          </label>
        </div>

        {/* Web Push subscribe/unsubscribe */}
        {webPush.supported && (
          <div className="px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">
                  Browser Push Subscription
                </p>
                <p className="text-sm text-zinc-500">
                  {webPush.subscribed
                    ? 'This browser is receiving push notifications.'
                    : webPush.permission === 'denied'
                      ? 'Notifications are blocked in browser settings.'
                      : 'Enable push notifications for this browser.'}
                </p>
              </div>
              <div>
                {webPush.subscribed ? (
                  <button
                    onClick={webPush.unsubscribe}
                    disabled={webPush.loading}
                    className="px-3 py-1.5 text-sm font-medium text-zinc-400 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50 transition-colors"
                    aria-label="Unsubscribe from push notifications"
                  >
                    {webPush.loading ? 'Processing...' : 'Unsubscribe'}
                  </button>
                ) : (
                  <button
                    onClick={webPush.subscribe}
                    disabled={webPush.loading || webPush.permission === 'denied'}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-orange-500 rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
                    aria-label="Subscribe to push notifications"
                  >
                    {webPush.loading ? 'Processing...' : 'Enable'}
                  </button>
                )}
              </div>
            </div>
            {webPush.error && (
              <p className="mt-2 text-sm text-red-400" role="alert">
                {webPush.error}
              </p>
            )}
          </div>
        )}

        {!webPush.supported && (
          <div className="px-4 py-4">
            <p className="text-sm text-zinc-500">
              Your browser does not support Web Push notifications. Try Chrome,
              Firefox, or Edge for push notification support.
            </p>
          </div>
        )}

        {/* Email toggle */}
        <div className="px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-100">Email Notifications</p>
            <p className="text-sm text-zinc-500">
              Weekly summary and important alerts
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={emailEnabled}
              onChange={(e) => handleNotificationToggle('email_enabled', e.target.checked)}
              disabled={notifSaving}
              aria-label="Toggle email notifications"
            />
            <div className="h-6 w-11 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
          </label>
        </div>

        {/* Quiet hours */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">Quiet Hours</p>
              <p className="text-sm text-zinc-500">
                {notificationPrefs?.quiet_hours_start && notificationPrefs?.quiet_hours_end
                  ? `${notificationPrefs.quiet_hours_start} - ${notificationPrefs.quiet_hours_end}`
                  : 'Not configured'}
              </p>
            </div>
            <button
              onClick={() => setEditingQuietHours(!editingQuietHours)}
              className="text-sm text-orange-500 hover:text-orange-400"
              aria-label="Configure quiet hours"
            >
              {editingQuietHours ? 'Cancel' : 'Configure'}
            </button>
          </div>
          {editingQuietHours && (
            <div className="mt-3 flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label htmlFor="quiet-start" className="text-xs text-zinc-500">
                  From
                </label>
                <input
                  id="quiet-start"
                  type="time"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="quiet-end" className="text-xs text-zinc-500">
                  To
                </label>
                <input
                  id="quiet-end"
                  type="time"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none"
                />
              </div>
              <button
                onClick={handleQuietHoursSave}
                disabled={quietHoursSaving}
                className="rounded-md bg-orange-500 px-3 py-1 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
              >
                {quietHoursSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {/* Priority (Pro+) */}
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
              <p className="text-sm text-zinc-500">Filter notifications by importance</p>
            </div>
            {prioritySaving && (
              <span className="text-xs text-zinc-500">Saving...</span>
            )}
          </div>
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
            <div className="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
              <p className="text-sm font-medium text-zinc-100 mb-1">{priorityCopy.title}</p>
              <p className="text-xs text-zinc-400 mb-2">{priorityCopy.summary}</p>
              <div className="space-y-1 text-xs text-zinc-500">
                <p className="font-medium text-zinc-400">Examples at this level:</p>
                {priorityCopy.examples.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          </div>
          {!isPaidTier && (
            <div className="mt-4 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
              <p className="text-sm text-orange-400 mb-2">
                Smart notifications help reduce notification fatigue by filtering based
                on importance.
              </p>
              <button
                onClick={() => router.push('/pricing')}
                className="text-sm font-medium text-orange-500 hover:text-orange-400"
              >
                Upgrade to Pro to enable
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
