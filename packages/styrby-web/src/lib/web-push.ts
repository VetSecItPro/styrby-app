/**
 * Web Push Server-Side Utility
 *
 * Provides functions to send push notifications to users' browsers via the
 * Web Push protocol. Uses the web-push library with VAPID authentication.
 *
 * WHY server-side only: The web-push library uses Node.js crypto APIs to
 * encrypt notification payloads with the subscriber's public key. It must
 * never be imported in client components or the browser bundle.
 *
 * @module web-push
 */

import webpush from 'web-push';
import { createAdminClient } from '@/lib/supabase/server';

// ============================================================================
// Types
// ============================================================================

/**
 * Payload for a push notification sent to a user's browser.
 * Matches the PushPayload interface expected by the service worker.
 */
export interface PushPayload {
  /** Notification title displayed to the user */
  title: string;

  /** Notification body text */
  body: string;

  /** Optional icon URL (defaults to app icon in the SW) */
  icon?: string;

  /** Optional URL to open when the notification is clicked */
  url?: string;

  /**
   * Optional tag for notification grouping.
   * Notifications with the same tag replace each other instead of stacking.
   */
  tag?: string;
}

/**
 * Result of sending push notifications to a single user.
 */
export interface PushSendResult {
  /** Number of notifications successfully delivered to the push service */
  sent: number;

  /** Number of notifications that failed to send */
  failed: number;

  /**
   * Number of expired/invalid subscriptions that were cleaned up.
   * A 410 Gone response from the push service means the subscription
   * has been revoked by the browser.
   */
  cleaned: number;
}

/**
 * Shape of the web_push_subscription JSONB column in device_tokens.
 */
interface StoredSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

/**
 * Row shape returned from the device_tokens query.
 */
interface DeviceTokenRow {
  id: string;
  token: string;
  web_push_subscription: StoredSubscription;
}

// ============================================================================
// VAPID Configuration
// ============================================================================

/**
 * WHY: VAPID (Voluntary Application Server Identification) keys authenticate
 * the application server to the push service. Without them, push services
 * reject notification requests. The subject (mailto:) identifies the
 * application operator for the push service to contact if there are issues.
 *
 * Keys are stored in environment variables and never hardcoded.
 * Generate with: npx web-push generate-vapid-keys
 */
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.NEXT_PUBLIC_APP_URL
  ? `mailto:support@${new URL(process.env.NEXT_PUBLIC_APP_URL).hostname}`
  : 'mailto:support@styrby.com';

/** Tracks whether VAPID has been configured on this process. */
let vapidConfigured = false;

/**
 * Configures the web-push library with VAPID credentials.
 * Called lazily on first use to avoid errors during import in environments
 * where VAPID keys are not set (e.g., CI, local dev without push setup).
 *
 * @throws {Error} When VAPID environment variables are missing
 *
 * @example
 * ensureVapidConfigured(); // Throws if keys missing
 * // Now safe to call webpush.sendNotification(...)
 */
function ensureVapidConfigured(): void {
  if (vapidConfigured) return;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error(
      'VAPID keys are not configured. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and ' +
        'VAPID_PRIVATE_KEY environment variables. Generate with: ' +
        'npx web-push generate-vapid-keys'
    );
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Sends a push notification to all active web push subscriptions for a user.
 *
 * For each subscription:
 * 1. Encrypts the payload using the subscription's public key
 * 2. Sends it to the push service endpoint
 * 3. If the subscription has expired (410 Gone), deletes it from the database
 *
 * @param userId - The Supabase user ID to send notifications to
 * @param payload - The notification content (title, body, icon, url, tag)
 * @returns Result with counts of sent, failed, and cleaned-up subscriptions
 * @throws {Error} When VAPID keys are not configured
 *
 * @example
 * const result = await sendPushToUser('user-uuid', {
 *   title: 'Session Complete',
 *   body: 'Your Claude session finished. Cost: $2.50',
 *   url: '/dashboard/sessions/session-uuid',
 *   tag: 'session-complete',
 * });
 * console.log(`Sent: ${result.sent}, Failed: ${result.failed}`);
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<PushSendResult> {
  ensureVapidConfigured();

  const supabase = createAdminClient();
  const result: PushSendResult = { sent: 0, failed: 0, cleaned: 0 };

  // Fetch all active web push subscriptions for this user
  const { data: tokens, error } = await supabase
    .from('device_tokens')
    .select('id, token, web_push_subscription')
    .eq('user_id', userId)
    .eq('platform', 'web')
    .eq('is_active', true);

  if (error) {
    console.error('Failed to fetch web push subscriptions:', error.message);
    return result;
  }

  if (!tokens || tokens.length === 0) {
    return result;
  }

  const payloadString = JSON.stringify(payload);

  // WHY: We send to all subscriptions in parallel for speed. A user may have
  // multiple browsers/devices with web push enabled. Using Promise.allSettled
  // ensures one failed subscription does not block others.
  const sendPromises = (tokens as DeviceTokenRow[]).map(async (token) => {
    const subscription = token.web_push_subscription;

    if (!subscription?.endpoint || !subscription?.keys) {
      result.failed++;
      return;
    }

    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
          },
        },
        payloadString
      );
      result.sent++;
    } catch (sendError: unknown) {
      const statusCode =
        sendError instanceof Error &&
        'statusCode' in sendError
          ? (sendError as { statusCode: number }).statusCode
          : 0;

      if (statusCode === 410 || statusCode === 404) {
        // WHY: A 410 Gone or 404 Not Found from the push service means the
        // subscription has been revoked (user unsubscribed via browser
        // settings, cleared site data, or the subscription expired).
        // We delete the stale row to avoid retrying on every send.
        await supabase
          .from('device_tokens')
          .delete()
          .eq('id', token.id);
        result.cleaned++;
      } else {
        console.error(
          `Failed to send push to subscription ${token.id}:`,
          sendError instanceof Error ? sendError.message : 'Unknown error'
        );
        result.failed++;
      }
    }
  });

  await Promise.allSettled(sendPromises);
  return result;
}
