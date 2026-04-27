/**
 * Retention Push Notification Utility
 *
 * Shared helper used by retention cron routes (weekly-digest,
 * budget-threshold, agent-finished) to send push notifications
 * with quiet-hours enforcement and audit trail.
 *
 * WHY a dedicated module separate from lib/notifications.ts:
 * notifications.ts handles web push (ServiceWorker/VAPID) for the
 * PWA. This module handles Expo push tokens (APNs/FCM) for the mobile
 * app. Both may eventually share a unified dispatcher, but during
 * this phase they handle different delivery paths.
 *
 * @module lib/pushNotifications
 */

import type { createAdminClient } from '@/lib/supabase/server';

/**
 * Notification types that can be sent via this utility.
 * Must match the CHECK constraint on the notifications.type column.
 */
export type RetentionNotificationType =
  | 'weekly_digest'
  | 'agent_finished'
  | 'budget_threshold'
  | 'weekly_summary_push'
  | 'referral_reward'
  | 'milestone';

/**
 * Parameters for sendRetentionPush.
 */
export interface SendRetentionPushParams {
  /** User to notify */
  userId: string;
  /** Notification type (for preference gating) */
  type: RetentionNotificationType;
  /** Push title */
  title: string;
  /** Push body */
  body: string;
  /** Data payload for deep-linking */
  data?: Record<string, unknown>;
  /** Admin supabase client (caller must provide to avoid re-creating) */
  supabase: ReturnType<typeof createAdminClient>;
  /** If true, check quiet hours and suppress if active */
  respectQuietHours?: boolean;
}

/**
 * Send a push notification to all registered devices for a user.
 *
 * Responsibilities:
 *   1. Look up active Expo push tokens from device_tokens
 *   2. Optionally check quiet hours against user's timezone
 *   3. Call the Expo Push API for each token
 *   4. Remove stale tokens (Expo returns DeviceNotRegistered error)
 *
 * WHY Expo Push API instead of direct APNs/FCM:
 * The Expo service abstracts APNs and FCM into a single HTTP endpoint.
 * It handles token format differences, error normalization, and delivery
 * receipts. Direct APNs/FCM calls would require separate certificates
 * and token management for iOS vs Android.
 *
 * @param params - Push notification parameters
 * @returns true if at least one token received the push, false otherwise
 */
export async function sendRetentionPush({
  userId,
  title,
  body,
  data,
  supabase,
  respectQuietHours = true,
}: SendRetentionPushParams): Promise<boolean> {
  // Fetch notification preferences to check quiet hours
  if (respectQuietHours) {
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select(
        'push_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone'
      )
      .eq('user_id', userId)
      .maybeSingle();

    if (prefs?.push_enabled === false) return false;

    if (prefs?.quiet_hours_enabled && prefs.quiet_hours_start && prefs.quiet_hours_end) {
      if (isInQuietHours(prefs.quiet_hours_start, prefs.quiet_hours_end, prefs.quiet_hours_timezone)) {
        return false;
      }
    }
  }

  // Fetch active Expo push tokens for this user
  const { data: tokens, error: tokenError } = await supabase
    .from('device_tokens')
    .select('id, token, platform')
    .eq('user_id', userId)
    .not('token', 'is', null);

  if (tokenError || !tokens || tokens.length === 0) {
    return false;
  }

  // Filter to Expo push tokens (format: ExponentPushToken[...])
  const expoTokens = tokens.filter((t) =>
    t.token?.startsWith('ExponentPushToken') || t.token?.startsWith('ExpoPushToken')
  );

  if (expoTokens.length === 0) return false;

  const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

  const messages = expoTokens.map((t) => ({
    to: t.token,
    title,
    body,
    data: data ?? {},
    sound: 'default',
    priority: 'high',
    channelId: 'default',
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
        // WHY include Accept-Encoding: Expo's API compresses large responses.
        // Without this header, responses with many tokens can be truncated.
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      console.error(`[pushNotifications] Expo push API error: ${response.status}`);
      return false;
    }

    const result = (await response.json()) as {
      data?: Array<{ status: string; id?: string; details?: { error?: string } }>;
    };

    // Handle stale tokens — DeviceNotRegistered means the app was uninstalled
    if (result.data) {
      const staleTokens: string[] = [];
      result.data.forEach((item, idx) => {
        if (
          item.status === 'error' &&
          item.details?.error === 'DeviceNotRegistered' &&
          expoTokens[idx]
        ) {
          staleTokens.push(expoTokens[idx].id);
        }
      });

      // Remove stale tokens (fire-and-forget; don't let cleanup block return value)
      if (staleTokens.length > 0) {
        supabase
          .from('device_tokens')
          .delete()
          .in('id', staleTokens)
          .then(({ error }) => {
            if (error) {
              console.error('[pushNotifications] Failed to remove stale tokens:', error.message);
            }
          });
      }

      const anyDelivered = result.data.some((item) => item.status === 'ok');
      return anyDelivered;
    }

    return true;
  } catch (error) {
    console.error(
      '[pushNotifications] Expo push API request failed:',
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

/**
 * Lazy per-timezone `Intl.DateTimeFormat` cache for the quiet-hours check.
 *
 * @internal
 */
const QUIET_HOURS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

/**
 * Returns a cached `Intl.DateTimeFormat` for the given IANA timezone.
 *
 * @param timezone - IANA timezone string.
 * @returns A reused formatter for the (HH:MM, 24-hour) shape.
 */
function getQuietHoursFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = QUIET_HOURS_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    QUIET_HOURS_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Check whether the current time falls within a user's quiet hours window.
 *
 * WHY timezone-aware: CLAUDE.md mandates CT for internal cron scheduling,
 * but quiet hours must respect the *user's* local timezone. A user in Tokyo
 * who sets quiet hours 22:00–08:00 should not receive pushes at 22:00 Tokyo
 * time just because the server is in CT.
 *
 * @param startTime - HH:MM quiet hours start (24-hour, local to user)
 * @param endTime - HH:MM quiet hours end (24-hour, local to user)
 * @param timezone - IANA timezone string (e.g. 'America/Chicago')
 * @returns true if current time is within the quiet window
 */
export function isInQuietHours(
  startTime: string,
  endTime: string,
  timezone: string = 'UTC'
): boolean {
  try {
    // Get current time in user's timezone
    const now = new Date();
    // WHY cached per timezone: the formatter options are otherwise constant,
    // but `timeZone` varies per user. Memoising by IANA string avoids
    // reparsing the ICU tables on every quiet-hours check (called on every
    // notification fan-out path). The cache is bounded by the small set of
    // timezones in the user base — no eviction needed.
    const formatter = getQuietHoursFormatter(timezone);

    const localTimeStr = formatter.format(now);
    // Intl may return '24:xx' for midnight — normalize to '00:xx'
    const [hourStr, minuteStr] = localTimeStr.replace(/^24:/, '00:').split(':');
    const currentMinutes = parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);

    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight windows (e.g. 22:00 - 08:00)
    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Overnight: quiet from startMinutes to midnight, or midnight to endMinutes
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  } catch {
    // Invalid timezone or time format — default to NOT quiet hours (don't suppress)
    return false;
  }
}
