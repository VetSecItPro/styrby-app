/**
 * Expo Push Notification Shared Module
 *
 * Handles communication with the Expo Push API for sending push notifications
 * to registered mobile devices. Includes token validation, batch sending,
 * and structured response parsing.
 *
 * @see https://docs.expo.dev/push-notifications/sending-notifications/
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Expo Push API endpoint for sending notifications.
 * Supports batching up to 100 notifications per request.
 */
const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Regex pattern for validating Expo push tokens.
 * Valid format: ExponentPushToken[<token_value>]
 *
 * WHY: Expo uses a proprietary token format that wraps the underlying APNs/FCM
 * token. Sending to an invalid token wastes API calls and can trigger rate
 * limiting from Expo's servers.
 */
const EXPO_PUSH_TOKEN_REGEX = /^ExponentPushToken\[.+\]$/;

/**
 * Maximum number of notifications Expo accepts in a single batch request.
 * Exceeding this returns a 400 error from the Expo API.
 */
const EXPO_MAX_BATCH_SIZE = 100;

// ============================================================================
// Types
// ============================================================================

/**
 * Priority levels for push notifications.
 * Maps to APNs priority (iOS) and FCM priority (Android).
 *
 * - "default": Normal delivery, may be batched by the OS for battery savings.
 * - "high": Delivered immediately, wakes the device. Use sparingly to avoid
 *   being throttled by Apple/Google.
 */
export type ExpoPushPriority = 'default' | 'high';

/**
 * Sound configuration for push notifications.
 * - "default": System default notification sound.
 * - null: Silent notification (no sound).
 */
export type ExpoPushSound = 'default' | null;

/**
 * The notification payload sent to the Expo Push API.
 * Each message targets one push token.
 */
export interface ExpoPushMessage {
  /** The Expo push token to deliver to (ExponentPushToken[...]) */
  to: string;

  /** Notification title displayed in the notification shade */
  title: string;

  /** Notification body text */
  body: string;

  /** Arbitrary data payload delivered to the app when notification is opened */
  data?: Record<string, unknown>;

  /** Sound to play when notification arrives */
  sound?: ExpoPushSound;

  /** Delivery priority - "high" for time-sensitive notifications */
  priority?: ExpoPushPriority;

  /**
   * Time-to-live in seconds. If the device is offline, Expo/APNs/FCM will
   * retry delivery for this duration. 0 = deliver now or drop.
   */
  ttl?: number;

  /**
   * iOS badge count to set on the app icon.
   * Not set by default to avoid overriding the app's badge management.
   */
  badge?: number;

  /**
   * Android notification channel ID.
   * Must match a channel created in the mobile app.
   */
  channelId?: string;
}

/**
 * Represents a single notification in the Expo Push API batch request body.
 * Identical to ExpoPushMessage but used for type clarity in API calls.
 */
export type ExpoPushRequestBody = ExpoPushMessage | ExpoPushMessage[];

/**
 * A single ticket returned by the Expo Push API for each notification sent.
 * A ticket confirms receipt by Expo, NOT delivery to the device.
 *
 * WHY separate status and error: Expo first queues the notification (ticket),
 * then delivers it asynchronously. A successful ticket means Expo accepted it;
 * a failed ticket means Expo rejected it before even trying to deliver.
 */
export interface ExpoPushTicket {
  /** "ok" means Expo accepted the notification for delivery */
  status: 'ok' | 'error';

  /**
   * Receipt ID for checking delivery status later.
   * Only present when status is "ok".
   */
  id?: string;

  /** Error message when status is "error" */
  message?: string;

  /**
   * Machine-readable error code.
   * Key codes:
   * - "DeviceNotRegistered": Token is invalid, should be removed from DB
   * - "MessageTooBig": Payload exceeds 4096 bytes
   * - "MessageRateExceeded": Too many messages to this device
   * - "MismatchSenderId": Token belongs to a different Expo project
   * - "InvalidCredentials": Push credentials are misconfigured
   */
  details?: {
    error?:
      | 'DeviceNotRegistered'
      | 'MessageTooBig'
      | 'MessageRateExceeded'
      | 'MismatchSenderId'
      | 'InvalidCredentials';
  };
}

/**
 * The complete response from the Expo Push API.
 * Contains one ticket per notification sent, in the same order.
 */
export interface ExpoPushResponse {
  /** Array of tickets, one per notification in the request */
  data: ExpoPushTicket[];
}

/**
 * Result of a batch send operation, providing a summary of delivery status
 * along with detailed per-token results for error handling.
 */
export interface ExpoPushSendResult {
  /** Total number of notifications attempted */
  totalSent: number;

  /** Number of notifications successfully accepted by Expo */
  successCount: number;

  /** Number of notifications rejected by Expo */
  failureCount: number;

  /**
   * Tokens that Expo reported as unregistered (invalid).
   * These should be deactivated in the device_tokens table to prevent
   * wasting API calls on future sends.
   */
  invalidTokens: string[];

  /** Detailed per-token ticket results for logging/debugging */
  tickets: Array<{
    token: string;
    ticket: ExpoPushTicket;
  }>;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates whether a string is a properly formatted Expo push token.
 *
 * Valid tokens follow the format: ExponentPushToken[<value>]
 * where <value> is a non-empty string assigned by Expo's push service.
 *
 * @param token - The string to validate as an Expo push token
 * @returns True if the token matches the ExponentPushToken[...] format
 *
 * @example
 * isExpoPushToken('ExponentPushToken[abc123]');  // true
 * isExpoPushToken('not-a-token');                 // false
 * isExpoPushToken('ExponentPushToken[]');          // false
 */
export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_REGEX.test(token);
}

// ============================================================================
// Core Send Function
// ============================================================================

/**
 * Sends push notifications to multiple Expo push tokens via the Expo Push API.
 *
 * Handles batching (Expo accepts max 100 per request), validates tokens before
 * sending, and aggregates results across batches into a single summary.
 *
 * WHY batch instead of individual sends: The Expo Push API is optimized for
 * batch delivery. Sending individually would multiply HTTP overhead and hit
 * rate limits faster. Batching also reduces latency for multi-device users.
 *
 * @param tokens - Array of Expo push tokens to send to
 * @param notification - The notification content (title, body, data, etc.)
 * @returns Aggregated result with success/failure counts and invalid tokens
 * @throws {Error} When the Expo Push API returns a non-2xx HTTP status
 *
 * @example
 * const result = await sendExpoPushNotifications(
 *   ['ExponentPushToken[abc123]', 'ExponentPushToken[def456]'],
 *   {
 *     title: 'Permission Required',
 *     body: 'Claude wants to write files',
 *     data: { screen: 'chat', sessionId: 'uuid-here' },
 *     sound: 'default',
 *     priority: 'high',
 *   }
 * );
 *
 * // Deactivate invalid tokens
 * for (const token of result.invalidTokens) {
 *   await deactivateToken(token);
 * }
 */
export async function sendExpoPushNotifications(
  tokens: string[],
  notification: Omit<ExpoPushMessage, 'to'>
): Promise<ExpoPushSendResult> {
  // Filter to valid tokens only
  const validTokens = tokens.filter(isExpoPushToken);

  if (validTokens.length === 0) {
    return {
      totalSent: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokens: tokens.filter((t) => !isExpoPushToken(t)),
      tickets: [],
    };
  }

  // Build messages for each token
  const messages: ExpoPushMessage[] = validTokens.map((token) => ({
    to: token,
    ...notification,
  }));

  // Split into batches of EXPO_MAX_BATCH_SIZE
  const batches: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += EXPO_MAX_BATCH_SIZE) {
    batches.push(messages.slice(i, i + EXPO_MAX_BATCH_SIZE));
  }

  // Send all batches and collect results
  const allTickets: Array<{ token: string; ticket: ExpoPushTicket }> = [];
  let successCount = 0;
  let failureCount = 0;
  const invalidTokens: string[] = [];

  for (const batch of batches) {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Expo Push API returned ${response.status}: ${errorText}`
      );
    }

    const result: ExpoPushResponse = await response.json();

    // Process each ticket in the batch
    for (let i = 0; i < result.data.length; i++) {
      const ticket = result.data[i];
      const token = batch[i].to;

      allTickets.push({ token, ticket });

      if (ticket.status === 'ok') {
        successCount++;
      } else {
        failureCount++;

        // WHY track DeviceNotRegistered separately: These tokens are
        // permanently invalid (user uninstalled app, token expired, etc.)
        // and should be removed from the database to prevent wasting
        // API calls and potentially triggering Expo rate limits.
        if (ticket.details?.error === 'DeviceNotRegistered') {
          invalidTokens.push(token);
        }
      }
    }
  }

  return {
    totalSent: validTokens.length,
    successCount,
    failureCount,
    invalidTokens,
    tickets: allTickets,
  };
}
