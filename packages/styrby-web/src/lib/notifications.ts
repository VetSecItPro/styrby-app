/**
 * Unified Notification Dispatcher
 *
 * Provides a single entry point for sending notifications to users across
 * all channels (Web Push, and in the future APNs/FCM for mobile). Handles
 * checking user preferences before dispatching.
 *
 * WHY: Without a unified dispatcher, each feature (budget alerts, session
 * events, team invites) would need to independently check preferences,
 * resolve channels, and handle failures. This creates duplication and makes
 * it easy to forget preference checks. A central dispatcher ensures
 * consistent behavior across all notification sources.
 *
 * @module notifications
 */

import { createAdminClient } from '@/lib/supabase/server';
import { sendPushToUser, type PushPayload } from '@/lib/web-push';

// ============================================================================
// Types
// ============================================================================

/**
 * Notification event types that the dispatcher handles.
 * Each type maps to a category for preference filtering.
 */
export type NotificationType =
  | 'budget_alert'
  | 'session_complete'
  | 'session_error'
  | 'permission_request'
  | 'team_invite';

/**
 * Priority levels for notification filtering.
 * Maps to the user's priority_threshold setting (1-5 scale).
 *
 * WHY: Smart notifications let Pro+ users filter by importance.
 * Priority 1 = only urgent, 5 = everything. The dispatcher compares
 * the notification's priority against the user's threshold.
 */
type NotificationPriority = 1 | 2 | 3 | 4 | 5;

/**
 * Payload for dispatching a notification to a user.
 */
export interface NotificationPayload {
  /** Notification title */
  title: string;

  /** Notification body text */
  body: string;

  /** Optional icon URL */
  icon?: string;

  /** Optional URL to navigate to on click */
  url?: string;

  /** Optional tag for notification grouping/dedup */
  tag?: string;
}

/**
 * Result of a notification dispatch operation.
 */
export interface DispatchResult {
  /** Whether the notification was sent via at least one channel */
  delivered: boolean;

  /** Channels that were attempted */
  channels: {
    webPush?: { sent: number; failed: number; cleaned: number };
    // Future channels:
    // apns?: { sent: number; failed: number };
    // fcm?: { sent: number; failed: number };
    // email?: { sent: boolean };
  };

  /** Reason if the notification was skipped entirely */
  skippedReason?: string;
}

/**
 * Shape of the notification_preferences row.
 */
interface NotificationPreferences {
  push_enabled: boolean;
  email_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  priority_threshold: number | null;
}

// ============================================================================
// Priority Mapping
// ============================================================================

/**
 * Maps notification types to their default priority level.
 *
 * WHY: Different event types have inherently different urgency levels.
 * Budget alerts and permission requests are high-priority because they
 * require immediate user attention. Session completions are moderate.
 * Team invites are low because they are not time-sensitive.
 */
const TYPE_PRIORITY: Record<NotificationType, NotificationPriority> = {
  budget_alert: 1,
  permission_request: 2,
  session_error: 2,
  session_complete: 3,
  team_invite: 4,
};

// ============================================================================
// Quiet Hours Check
// ============================================================================

/**
 * Checks whether the current time falls within the user's quiet hours.
 *
 * WHY: Users configure quiet hours to avoid notifications during sleep or
 * focus time. We check the user's local time (approximated by UTC for now)
 * against their configured window.
 *
 * @param start - Quiet hours start time in HH:MM format (e.g., "22:00")
 * @param end - Quiet hours end time in HH:MM format (e.g., "07:00")
 * @returns True if the current time is within quiet hours
 *
 * @example
 * isWithinQuietHours('22:00', '07:00'); // true at 23:00 UTC
 * isWithinQuietHours('22:00', '07:00'); // false at 12:00 UTC
 */
function isWithinQuietHours(start: string, end: string): boolean {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight quiet hours (e.g., 22:00 to 07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Dispatches a notification to a user across all eligible channels.
 *
 * The dispatch flow:
 * 1. Fetches the user's notification preferences
 * 2. Checks if push is enabled
 * 3. Checks quiet hours (skips if currently in quiet period)
 * 4. Checks priority threshold (skips if notification is below threshold)
 * 5. Sends via Web Push to all active browser subscriptions
 * 6. (Future) Sends via APNs/FCM for mobile devices
 *
 * @param userId - The Supabase user ID to notify
 * @param type - The notification event type (determines default priority)
 * @param payload - The notification content
 * @returns Dispatch result with per-channel delivery status
 *
 * @example
 * const result = await dispatchNotification(
 *   'user-uuid',
 *   'budget_alert',
 *   {
 *     title: 'Budget Warning',
 *     body: 'You have used 80% of your monthly budget.',
 *     url: '/dashboard/costs',
 *     tag: 'budget-warning',
 *   }
 * );
 *
 * if (result.delivered) {
 *   console.log('Notification sent to user');
 * } else {
 *   console.log('Skipped:', result.skippedReason);
 * }
 */
export async function dispatchNotification(
  userId: string,
  type: NotificationType,
  payload: NotificationPayload
): Promise<DispatchResult> {
  const supabase = createAdminClient();
  const result: DispatchResult = {
    delivered: false,
    channels: {},
  };

  // Fetch user's notification preferences
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('push_enabled, email_enabled, quiet_hours_start, quiet_hours_end, priority_threshold')
    .eq('user_id', userId)
    .single();

  const preferences = prefs as NotificationPreferences | null;

  // Default to push enabled if no preferences row exists (new users)
  const pushEnabled = preferences?.push_enabled ?? true;

  if (!pushEnabled) {
    result.skippedReason = 'Push notifications disabled by user';
    return result;
  }

  // Check quiet hours
  if (
    preferences?.quiet_hours_start &&
    preferences?.quiet_hours_end &&
    isWithinQuietHours(preferences.quiet_hours_start, preferences.quiet_hours_end)
  ) {
    // WHY: Budget alerts (priority 1) bypass quiet hours because they
    // indicate potential cost overruns that need immediate attention.
    const notifPriority = TYPE_PRIORITY[type];
    if (notifPriority > 1) {
      result.skippedReason = 'Quiet hours active';
      return result;
    }
  }

  // Check priority threshold (Pro+ feature)
  const threshold = preferences?.priority_threshold ?? 5;
  const notifPriority = TYPE_PRIORITY[type];

  if (notifPriority > threshold) {
    result.skippedReason = `Notification priority (${notifPriority}) below user threshold (${threshold})`;
    return result;
  }

  // Send via Web Push
  try {
    const pushPayload: PushPayload = {
      title: payload.title,
      body: payload.body,
      icon: payload.icon,
      url: payload.url,
      tag: payload.tag,
    };

    const pushResult = await sendPushToUser(userId, pushPayload);
    result.channels.webPush = pushResult;

    if (pushResult.sent > 0) {
      result.delivered = true;
    }
  } catch (error) {
    console.error(
      'Web push dispatch failed:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    result.channels.webPush = { sent: 0, failed: 1, cleaned: 0 };
  }

  // Future: APNs/FCM for mobile push
  // Future: Email notifications via Resend

  return result;
}
