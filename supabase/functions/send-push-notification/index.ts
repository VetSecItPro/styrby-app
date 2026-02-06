/**
 * Send Push Notification - Supabase Edge Function
 *
 * Accepts webhook-style POST requests from internal services (CLI backend,
 * budget checker, session manager) and delivers push notifications to users'
 * mobile devices via the Expo Push API.
 *
 * Flow:
 * 1. Validate authorization (service role key only)
 * 2. Validate and parse the request payload
 * 3. Check rate limit (max 100 notifications per user per hour)
 * 4. Look up user's active device tokens
 * 5. Check notification preferences (push enabled, quiet hours, per-type)
 * 6. Build notification payload based on event type
 * 7. Send via Expo Push API
 * 8. Deactivate invalid tokens
 * 9. Log delivery to audit_log
 * 10. Return delivery status
 *
 * @auth Service role key required (Bearer token in Authorization header)
 * @rateLimit 100 notifications per user per hour
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';
import {
  sendExpoPushNotifications,
  isExpoPushToken,
  type ExpoPushSendResult,
} from '../_shared/expo-push.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * Notification event types that this function handles.
 * Each type maps to a specific notification template with pre-defined
 * title, body, and routing behavior in the mobile app.
 */
type NotificationEventType =
  | 'permission_request'
  | 'session_started'
  | 'session_completed'
  | 'session_error'
  | 'budget_warning'
  | 'budget_exceeded';

/**
 * Data payload included with the notification event.
 * Not all fields are required for every event type.
 */
interface NotificationEventData {
  /** Session UUID for navigation to specific session */
  sessionId?: string;

  /** Which AI agent triggered the event (e.g., "Claude", "Codex") */
  agentType?: string;

  /** Custom notification title override */
  title?: string;

  /** Custom notification body override */
  body?: string;

  /** Cost in USD for session completion events */
  costUsd?: number;

  /** Budget threshold in USD for budget events */
  budgetThreshold?: number;

  /** Type of permission being requested (e.g., "write files") */
  permissionType?: string;

  /** Risk level for permission requests (low, medium, high) */
  riskLevel?: 'low' | 'medium' | 'high';

  /** Tool name for permission requests (e.g., "bash", "write") */
  toolName?: string;

  /** Session duration in milliseconds (for session completion events) */
  sessionDurationMs?: number;
}

/**
 * The incoming request payload from internal services.
 */
interface NotificationRequest {
  /** The type of event that triggered this notification */
  type: NotificationEventType;

  /** The Supabase user ID to notify */
  userId: string;

  /** Event-specific data for building the notification */
  data: NotificationEventData;
}

/**
 * Notification template built from the event type and data.
 * Used to construct the Expo push message.
 */
interface NotificationPayload {
  /** Notification title displayed in the notification shade */
  title: string;

  /** Notification body text */
  body: string;

  /** Data payload delivered to the app for navigation routing */
  data: Record<string, unknown>;

  /** Sound to play ("default" or null for silent) */
  sound: 'default' | null;

  /** Delivery priority ("high" for time-sensitive like permissions) */
  priority: 'default' | 'high';

  /**
   * Android notification channel ID.
   * "permissions" channel has more aggressive vibration pattern.
   */
  channelId?: string;
}

/**
 * Row shape from the notification_preferences table.
 * Used to check if the user wants to receive this type of notification.
 */
interface NotificationPreferences {
  push_enabled: boolean;
  push_permission_requests: boolean;
  push_session_errors: boolean;
  push_budget_alerts: boolean;
  push_session_complete: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  /** Priority threshold for smart notifications (1-5, lower = more restrictive) */
  priority_threshold: number;
}

/**
 * Row shape from the subscriptions table.
 * Used to determine if the user has access to smart notification filtering.
 */
interface SubscriptionInfo {
  tier: 'free' | 'pro' | 'power';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused';
}

/**
 * The API response returned to the caller.
 */
interface NotificationResponse {
  /** Whether the notification was successfully delivered */
  success: boolean;

  /** Human-readable status message */
  message: string;

  /** Number of devices the notification was sent to */
  deviceCount: number;

  /** Number of devices that successfully received the notification */
  successCount: number;

  /** Number of devices that failed to receive */
  failureCount: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of notifications allowed per user per hour.
 *
 * WHY 100 per hour: This balances between allowing burst activity (e.g., rapid
 * permission requests during an automated refactor) and protecting against
 * runaway notification floods from misconfigured callers. A typical heavy
 * coding session generates 10-30 notifications; 100 provides generous headroom.
 */
const RATE_LIMIT_PER_HOUR = 100;

/**
 * Valid notification event types for payload validation.
 * Used to reject requests with unknown event types before processing.
 */
const VALID_EVENT_TYPES: NotificationEventType[] = [
  'permission_request',
  'session_started',
  'session_completed',
  'session_error',
  'budget_warning',
  'budget_exceeded',
];

/**
 * Base priority scores by event type.
 * Scale: 1 (most urgent) to 5 (informational only).
 */
const BASE_PRIORITY_BY_EVENT: Record<NotificationEventType, number> = {
  permission_request: 2,
  session_started: 5,
  session_completed: 4,
  session_error: 2,
  budget_warning: 2,
  budget_exceeded: 1,
};

/**
 * Risk level adjustments for permission requests.
 */
const RISK_LEVEL_ADJUSTMENT: Record<string, number> = {
  high: -1,
  medium: 0,
  low: 1,
};

/**
 * Tools considered dangerous that increase notification priority.
 */
const DANGEROUS_TOOLS = new Set([
  'bash', 'execute', 'run_command', 'write', 'write_file',
  'edit', 'edit_file', 'delete', 'delete_file', 'rm', 'mv',
  'git', 'npm', 'pip', 'curl', 'wget',
]);

/**
 * Cost thresholds in USD for priority adjustments.
 */
const COST_THRESHOLDS = { HIGH: 10.0, MEDIUM: 5.0, LOW: 1.0 };

/**
 * Session duration threshold (1 hour) for priority adjustment.
 */
const LONG_SESSION_THRESHOLD_MS = 60 * 60 * 1000;

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates the incoming request payload structure and types.
 *
 * Checks for required fields (type, userId) and validates that the event
 * type is one of the supported types. Does NOT validate userId format
 * because the DB lookup will handle invalid UUIDs gracefully.
 *
 * @param body - The parsed JSON request body
 * @returns The validated payload, or null with an error message
 */
function validatePayload(
  body: unknown
): { valid: true; payload: NotificationRequest } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // Validate required fields
  if (!obj.type || typeof obj.type !== 'string') {
    return { valid: false, error: 'Missing or invalid "type" field' };
  }

  if (!VALID_EVENT_TYPES.includes(obj.type as NotificationEventType)) {
    return {
      valid: false,
      error: `Invalid event type "${obj.type}". Must be one of: ${VALID_EVENT_TYPES.join(', ')}`,
    };
  }

  if (!obj.userId || typeof obj.userId !== 'string') {
    return { valid: false, error: 'Missing or invalid "userId" field' };
  }

  // Validate UUID format for userId
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(obj.userId)) {
    return { valid: false, error: '"userId" must be a valid UUID' };
  }

  // data is optional but must be an object if provided
  if (obj.data !== undefined && (typeof obj.data !== 'object' || obj.data === null)) {
    return { valid: false, error: '"data" must be an object if provided' };
  }

  return {
    valid: true,
    payload: {
      type: obj.type as NotificationEventType,
      userId: obj.userId as string,
      data: (obj.data as NotificationEventData) || {},
    },
  };
}

// ============================================================================
// Authorization
// ============================================================================

/**
 * Validates that the request is authorized with the Supabase service role key.
 *
 * WHY service role key only: This function is called by internal services
 * (CLI backend, budget checker), not by end users. Requiring the service role
 * key ensures only trusted server-side callers can trigger notifications.
 * End users cannot send arbitrary notifications to other users.
 *
 * @param req - The incoming HTTP request
 * @param serviceRoleKey - The expected service role key from environment
 * @returns True if the Authorization header contains the correct service role key
 */
function isAuthorized(req: Request, serviceRoleKey: string): boolean {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <key>" and raw "<key>" formats
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // WHY constant-time comparison: Prevents timing attacks where an attacker
  // could determine the correct key character-by-character by measuring
  // response time differences. Service role keys are high-value targets.
  if (token.length !== serviceRoleKey.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ serviceRoleKey.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Checks whether the user has exceeded the notification rate limit.
 *
 * Queries the audit_log table for notification events within the past hour.
 * Uses the audit_log instead of a dedicated rate limit table because:
 * 1. We already log every notification to audit_log (no extra writes)
 * 2. The BRIN index on created_at makes time-range queries efficient
 * 3. One less table to maintain
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user ID to check
 * @returns True if the user is within rate limits (allowed to send)
 */
async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // WHY count via audit_log: We log every notification send there anyway,
  // so this avoids needing a separate rate-limit counter table. The
  // idx_audit_log_user index on (user_id, created_at DESC) makes this fast.
  const { count, error } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action', 'settings_updated')
    .eq('resource_type', 'push_notification')
    .gte('created_at', oneHourAgo);

  if (error) {
    // WHY fail open: If we can't check the rate limit (DB error), we allow
    // the notification through. Missing a rate limit check is less harmful
    // than blocking a critical permission request notification. The 100/hr
    // limit is generous enough that transient DB errors won't cause floods.
    console.error('Rate limit check failed:', error);
    return true;
  }

  return (count ?? 0) < RATE_LIMIT_PER_HOUR;
}

// ============================================================================
// Notification Preferences
// ============================================================================

/**
 * Result from checking notification preferences.
 * Includes whether to send and the user's priority threshold.
 */
interface PreferenceCheckResult {
  /** Whether the notification should be sent based on basic preferences */
  shouldSend: boolean;
  /** Reason for suppression if shouldSend is false */
  suppressionReason: string | null;
  /** User's priority threshold (1-5), defaults to 3 if not set */
  priorityThreshold: number;
  /** Whether currently in quiet hours */
  isQuietHours: boolean;
}

/**
 * Fetches and evaluates the user's notification preferences.
 *
 * Checks three layers of preferences:
 * 1. Global push_enabled toggle (master switch)
 * 2. Per-type preferences (e.g., push_session_errors)
 * 3. Quiet hours (time-based do-not-disturb)
 *
 * If the user has no preferences row, returns true (opt-in by default).
 *
 * WHY default to allowing: New users should receive notifications immediately
 * after enabling push. The notification_preferences row is only created when
 * the user explicitly customizes settings. Defaulting to "send" ensures no
 * silent gap between registration and preference configuration.
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user ID to check preferences for
 * @param eventType - The notification event type to check against per-type prefs
 * @returns PreferenceCheckResult with send decision and priority threshold
 */
async function checkNotificationPreferences(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  eventType: NotificationEventType
): Promise<PreferenceCheckResult> {
  const { data: prefs, error } = await supabase
    .from('notification_preferences')
    .select(
      'push_enabled, push_permission_requests, push_session_errors, push_budget_alerts, push_session_complete, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, priority_threshold'
    )
    .eq('user_id', userId)
    .single();

  // Default result for users with no preferences
  if (error || !prefs) {
    return {
      shouldSend: true,
      suppressionReason: null,
      priorityThreshold: 3, // Default threshold
      isQuietHours: false,
    };
  }

  const preferences = prefs as NotificationPreferences;

  // Check master push toggle
  if (!preferences.push_enabled) {
    return {
      shouldSend: false,
      suppressionReason: 'push_disabled',
      priorityThreshold: preferences.priority_threshold ?? 3,
      isQuietHours: false,
    };
  }

  // Check per-type preferences
  const typeAllowed = isTypeAllowed(preferences, eventType);
  if (!typeAllowed) {
    return {
      shouldSend: false,
      suppressionReason: 'type_disabled',
      priorityThreshold: preferences.priority_threshold ?? 3,
      isQuietHours: false,
    };
  }

  // Check quiet hours
  let inQuietHours = false;
  if (preferences.quiet_hours_enabled) {
    inQuietHours = isInQuietHours(
      preferences.quiet_hours_start,
      preferences.quiet_hours_end,
      preferences.quiet_hours_timezone
    );
    if (inQuietHours) {
      return {
        shouldSend: false,
        suppressionReason: 'quiet_hours',
        priorityThreshold: preferences.priority_threshold ?? 3,
        isQuietHours: true,
      };
    }
  }

  return {
    shouldSend: true,
    suppressionReason: null,
    priorityThreshold: preferences.priority_threshold ?? 3,
    isQuietHours: false,
  };
}

/**
 * Legacy wrapper for backward compatibility.
 * @deprecated Use checkNotificationPreferences instead
 */
async function shouldSendNotification(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  eventType: NotificationEventType
): Promise<boolean> {
  const result = await checkNotificationPreferences(supabase, userId, eventType);
  return result.shouldSend;
}

/**
 * Checks whether a specific notification type is enabled in user preferences.
 *
 * Maps each event type to its corresponding preference column.
 * Types not explicitly mapped (like session_started) are always allowed
 * because they don't have a dedicated preference toggle.
 *
 * @param prefs - The user's notification preferences
 * @param eventType - The notification event type to check
 * @returns True if the user has enabled notifications for this type
 */
function isTypeAllowed(
  prefs: NotificationPreferences,
  eventType: NotificationEventType
): boolean {
  switch (eventType) {
    case 'permission_request':
      return prefs.push_permission_requests;
    case 'session_error':
      return prefs.push_session_errors;
    case 'session_completed':
      return prefs.push_session_complete;
    case 'budget_warning':
    case 'budget_exceeded':
      return prefs.push_budget_alerts;
    case 'session_started':
      // WHY no preference column: session_started is a low-frequency,
      // informational notification. It was intentionally omitted from
      // per-type preferences to keep the settings UI simple. If users
      // don't want it, they can disable push entirely.
      return true;
    default:
      return true;
  }
}

/**
 * Determines whether the current time falls within the user's quiet hours.
 *
 * Quiet hours define a daily do-not-disturb window. For example, a user might
 * set 22:00 to 07:00 to avoid notifications while sleeping. This function
 * handles overnight ranges (where start > end) correctly.
 *
 * WHY timezone-aware: Users in different timezones need their quiet hours to
 * apply relative to their local time, not UTC. A user in PST setting quiet
 * hours 10pm-7am would be incorrectly blocked at 2pm PST if we used UTC.
 *
 * @param startTime - Quiet hours start in "HH:MM:SS" format, or null (no quiet hours)
 * @param endTime - Quiet hours end in "HH:MM:SS" format, or null (no quiet hours)
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @returns True if the current time is within the quiet hours window
 */
function isInQuietHours(
  startTime: string | null,
  endTime: string | null,
  timezone: string
): boolean {
  if (!startTime || !endTime) {
    return false;
  }

  // Get current time in the user's timezone
  const now = new Date();
  const userTimeStr = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: timezone,
  });

  // Parse times to minutes since midnight for easy comparison
  const currentMinutes = timeToMinutes(userTimeStr);
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  // WHY two comparison modes: Quiet hours can be "same-day" (09:00 to 17:00)
  // or "overnight" (22:00 to 07:00). Overnight ranges wrap past midnight,
  // so we need to check if the current time is OUTSIDE the non-quiet window
  // instead of inside the quiet window.
  if (startMinutes <= endMinutes) {
    // Same-day range: e.g., 09:00 to 17:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range: e.g., 22:00 to 07:00
    // Current time is in quiet hours if it's after start OR before end
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Converts a "HH:MM:SS" or "HH:MM" time string to minutes since midnight.
 *
 * @param time - Time string in "HH:MM:SS" or "HH:MM" format
 * @returns Minutes since midnight (0-1439)
 */
function timeToMinutes(time: string): number {
  const parts = time.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  return hours * 60 + minutes;
}

// ============================================================================
// Notification Payload Builder
// ============================================================================

/**
 * Builds the notification payload (title, body, data, priority) based on
 * the event type and associated data.
 *
 * Each event type has a pre-defined template that creates user-friendly
 * notification text and includes routing data so the mobile app can navigate
 * to the relevant screen when the notification is tapped.
 *
 * @param type - The notification event type
 * @param data - Event-specific data for template interpolation
 * @returns The constructed notification payload
 */
function buildNotificationPayload(
  type: NotificationEventType,
  data: NotificationEventData
): NotificationPayload {
  switch (type) {
    case 'permission_request':
      return {
        title: data.title || 'Permission Required',
        body:
          data.body ||
          `${data.agentType || 'Agent'} wants to ${data.permissionType || 'perform an action'}`,
        data: {
          screen: 'chat',
          sessionId: data.sessionId,
          type: 'permission_request',
        },
        sound: 'default',
        priority: 'high',
        // WHY "permissions" channel: The mobile app registers this Android
        // channel with a more aggressive vibration pattern and red LED color
        // to distinguish urgent permission requests from informational
        // notifications. See notifications.ts line 79.
        channelId: 'permissions',
      };

    case 'session_started':
      return {
        title: data.title || `${data.agentType || 'Agent'} Session Started`,
        body: data.body || 'New coding session active',
        data: {
          screen: 'dashboard',
          sessionId: data.sessionId,
          type: 'session_started',
        },
        sound: 'default',
        priority: 'default',
      };

    case 'session_completed':
      return {
        title: data.title || 'Session Complete',
        body:
          data.body ||
          (data.costUsd !== undefined
            ? `Cost: $${data.costUsd.toFixed(4)}`
            : 'Session finished'),
        data: {
          screen: 'sessions',
          sessionId: data.sessionId,
          type: 'session_completed',
        },
        sound: 'default',
        priority: 'default',
      };

    case 'session_error':
      return {
        title: data.title || 'Session Error',
        body:
          data.body ||
          `${data.agentType || 'Agent'} encountered an error`,
        data: {
          screen: 'chat',
          sessionId: data.sessionId,
          type: 'session_error',
        },
        sound: 'default',
        priority: 'high',
      };

    case 'budget_warning': {
      // Calculate percentage if both current cost and threshold are available
      const percentage =
        data.costUsd !== undefined && data.budgetThreshold
          ? Math.round((data.costUsd / data.budgetThreshold) * 100)
          : null;

      return {
        title: data.title || 'Budget Warning',
        body:
          data.body ||
          (percentage !== null
            ? `Spending at ${percentage}% of $${data.budgetThreshold?.toFixed(2)}`
            : `Approaching budget threshold of $${data.budgetThreshold?.toFixed(2) || '?'}`),
        data: {
          screen: 'costs',
          type: 'budget_warning',
          budgetThreshold: data.budgetThreshold,
        },
        sound: 'default',
        priority: 'high',
      };
    }

    case 'budget_exceeded':
      return {
        title: data.title || 'Budget Exceeded',
        body:
          data.body ||
          `Spending exceeded $${data.budgetThreshold?.toFixed(2) || '?'}`,
        data: {
          screen: 'costs',
          type: 'budget_exceeded',
          budgetThreshold: data.budgetThreshold,
        },
        sound: 'default',
        priority: 'high',
      };

    default: {
      // WHY exhaustive check: TypeScript's never type ensures we handle every
      // NotificationEventType. If a new type is added to the union without
      // adding a case here, the build will fail at compile time.
      const _exhaustiveCheck: never = type;
      throw new Error(`Unhandled notification type: ${_exhaustiveCheck}`);
    }
  }
}

// ============================================================================
// Device Token Lookup
// ============================================================================

/**
 * Fetches all active, valid Expo push tokens for a user.
 *
 * Queries the device_tokens table for tokens that are:
 * - Active (is_active = true)
 * - Valid Expo format (ExponentPushToken[...])
 *
 * WHY filter is_active in query: Tokens are deactivated when the Expo API
 * reports DeviceNotRegistered (app uninstalled), or when the user logs out.
 * Querying only active tokens avoids wasting Expo API calls on known-dead
 * tokens and reduces latency.
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user ID to fetch tokens for
 * @returns Array of active Expo push token strings
 */
async function getActiveDeviceTokens(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<string[]> {
  const { data: devices, error } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) {
    console.error('Error fetching device tokens:', error);
    return [];
  }

  if (!devices || devices.length === 0) {
    return [];
  }

  // Filter to valid Expo tokens only (safety check in case non-Expo tokens
  // are stored, e.g., raw FCM tokens from a future web push integration)
  return devices
    .map((d: { token: string }) => d.token)
    .filter(isExpoPushToken);
}

// ============================================================================
// Token Deactivation
// ============================================================================

/**
 * Deactivates device tokens that Expo reported as invalid (DeviceNotRegistered).
 *
 * Instead of deleting, we set is_active = false and increment failed_count.
 * This preserves the record for debugging (when did the user uninstall?)
 * while ensuring we don't waste API calls on future sends.
 *
 * @param supabase - Supabase client with service role privileges
 * @param invalidTokens - Array of token strings reported as invalid by Expo
 */
async function deactivateInvalidTokens(
  supabase: ReturnType<typeof createClient>,
  invalidTokens: string[]
): Promise<void> {
  if (invalidTokens.length === 0) {
    return;
  }

  for (const token of invalidTokens) {
    // WHY individual updates instead of batch: We need to deactivate each
    // token and the number of invalid tokens per send is typically 0-2,
    // making the overhead negligible.
    const { error } = await supabase
      .from('device_tokens')
      .update({ is_active: false })
      .eq('token', token);

    if (error) {
      console.error(`Failed to deactivate token ${token}:`, error);
    }
  }
}

// ============================================================================
// Audit Logging
// ============================================================================

/**
 * Logs a notification delivery event to the audit_log table.
 *
 * Uses the 'settings_updated' audit_action enum value with resource_type
 * 'push_notification' to track notification sends. This is a pragmatic
 * choice because the audit_action enum doesn't include a dedicated
 * 'notification_sent' value, and altering enums in production requires
 * a migration.
 *
 * WHY log to audit_log: Provides traceability for debugging delivery issues,
 * tracking notification volume per user, and the rate limiting check in
 * checkRateLimit() reads from this same table.
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user who was notified
 * @param eventType - The notification event type
 * @param result - The delivery result from the Expo Push API
 */
async function logNotificationDelivery(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  eventType: NotificationEventType,
  result: ExpoPushSendResult
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    user_id: userId,
    // WHY 'settings_updated': The audit_action enum doesn't have a
    // 'notification_sent' value. Using 'settings_updated' with a distinct
    // resource_type allows us to query notification logs specifically
    // while working within the existing enum constraint. A future migration
    // should add a dedicated enum value.
    action: 'settings_updated',
    resource_type: 'push_notification',
    metadata: {
      event_type: eventType,
      total_sent: result.totalSent,
      success_count: result.successCount,
      failure_count: result.failureCount,
      invalid_tokens_deactivated: result.invalidTokens.length,
    },
  });

  if (error) {
    // WHY not throw: Audit log failures should not prevent the notification
    // from being reported as successful. The notification was already sent;
    // failing to log it is a monitoring issue, not a delivery failure.
    console.error('Failed to log notification delivery:', error);
  }
}

// ============================================================================
// Priority Scoring
// ============================================================================

/**
 * Calculates the notification priority score (1-5) for an event.
 *
 * Priority scale:
 * 1 = Critical/Urgent (budget exceeded, high-risk dangerous tools)
 * 2 = High (permission requests, budget warnings, errors)
 * 3 = Medium (medium-risk operations, significant costs)
 * 4 = Normal (low-risk operations, low cost completions)
 * 5 = Informational (session started, routine updates)
 *
 * @param type - The notification event type
 * @param data - Event-specific data for priority calculation
 * @returns Priority score between 1 (most urgent) and 5 (least urgent)
 */
function calculatePriority(
  type: NotificationEventType,
  data: NotificationEventData
): number {
  let priority = BASE_PRIORITY_BY_EVENT[type] ?? 3;

  // Risk level adjustment for permission requests
  if (type === 'permission_request' && data.riskLevel) {
    const adjustment = RISK_LEVEL_ADJUSTMENT[data.riskLevel] ?? 0;
    priority += adjustment;
  }

  // Cost impact adjustment
  if (data.costUsd !== undefined && data.costUsd > 0) {
    if (data.costUsd > COST_THRESHOLDS.HIGH) {
      priority -= 2; // Very high cost = more urgent
    } else if (data.costUsd > COST_THRESHOLDS.MEDIUM) {
      priority -= 1; // Notable cost = more important
    } else if (data.costUsd <= COST_THRESHOLDS.LOW) {
      priority += 1; // Low cost = less urgent
    }
  }

  // Session duration adjustment for completion events
  if (type === 'session_completed' && data.sessionDurationMs !== undefined) {
    if (data.sessionDurationMs > LONG_SESSION_THRESHOLD_MS) {
      priority -= 1; // Long sessions are more valuable
    } else if (data.sessionDurationMs < 5 * 60 * 1000) {
      priority += 1; // Very short sessions are less important
    }
  }

  // Dangerous tool adjustment for permission requests
  if (type === 'permission_request' && data.toolName) {
    const toolLower = data.toolName.toLowerCase();
    const isDangerous =
      DANGEROUS_TOOLS.has(toolLower) ||
      toolLower.includes('bash') ||
      toolLower.includes('execute') ||
      toolLower.includes('write') ||
      toolLower.includes('delete');

    if (isDangerous) {
      priority -= 1; // Dangerous tools need more attention
    }
  }

  // Clamp to valid range
  return Math.max(1, Math.min(5, priority));
}

/**
 * Fetches the user's subscription tier to determine if they have access
 * to smart notification filtering.
 *
 * WHY tier gating: Smart notifications is a Pro+ feature. Free users
 * receive all notifications to ensure they don't miss anything important.
 * This encourages upgrades while providing value to paying customers.
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user ID to check
 * @returns Subscription info or null if no subscription found
 */
async function getUserSubscription(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<SubscriptionInfo | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier, status')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    // No subscription = free tier
    return null;
  }

  return data as SubscriptionInfo;
}

/**
 * Checks if smart notification filtering should be applied based on
 * subscription tier and priority threshold.
 *
 * @param calculatedPriority - The notification's calculated priority (1-5)
 * @param userThreshold - User's priority threshold setting (1-5)
 * @param subscription - User's subscription info
 * @returns True if notification should be sent, false if filtered
 */
function shouldSendBasedOnPriority(
  calculatedPriority: number,
  userThreshold: number,
  subscription: SubscriptionInfo | null
): boolean {
  // Free users get all notifications (no filtering)
  // Tier gating: only Pro and Power users have smart filtering
  if (!subscription || subscription.tier === 'free') {
    return true;
  }

  // Inactive subscriptions also get all notifications
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return true;
  }

  // For paid tiers, send only if priority is urgent enough
  // Lower priority number = more urgent = should get through
  return calculatedPriority <= userThreshold;
}

// ============================================================================
// Notification Logging
// ============================================================================

/**
 * Logs a notification event to the notification_logs table for analytics.
 *
 * This table tracks both sent and suppressed notifications, enabling:
 * - Analytics on notification volume and filtering effectiveness
 * - User-facing stats ("you've saved X% notification noise")
 * - Debugging notification delivery issues
 *
 * @param supabase - Supabase client with service role privileges
 * @param userId - The user who would receive the notification
 * @param eventType - The notification event type
 * @param title - Notification title
 * @param body - Notification body
 * @param calculatedPriority - The calculated priority score
 * @param userThreshold - User's priority threshold setting
 * @param wasSent - Whether the notification was actually sent
 * @param suppressionReason - Why it was suppressed (if applicable)
 * @param data - Additional event data
 */
async function logNotificationEvent(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  eventType: NotificationEventType,
  title: string,
  body: string,
  calculatedPriority: number,
  userThreshold: number,
  wasSent: boolean,
  suppressionReason: string | null,
  data: NotificationEventData
): Promise<void> {
  const { error } = await supabase.from('notification_logs').insert({
    user_id: userId,
    event_type: eventType,
    notification_title: title,
    notification_body: body,
    calculated_priority: calculatedPriority,
    user_threshold: userThreshold,
    was_sent: wasSent,
    suppression_reason: suppressionReason,
    session_id: data.sessionId || null,
    cost_usd: data.costUsd || null,
    metadata: {
      agent_type: data.agentType,
      risk_level: data.riskLevel,
      tool_name: data.toolName,
    },
  });

  if (error) {
    // Non-fatal: don't fail the notification send if logging fails
    console.error('Failed to log notification event:', error);
  }
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Creates a standardized JSON response with proper headers.
 *
 * @param body - Response body to serialize as JSON
 * @param status - HTTP status code
 * @returns Response object with JSON content type
 */
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // ──────────────────────────────────────────
  // Method check
  // ──────────────────────────────────────────
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // ──────────────────────────────────────────
  // Environment variables
  // ──────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ error: 'Server configuration error' }, 500);
  }

  // ──────────────────────────────────────────
  // Authorization
  // ──────────────────────────────────────────
  if (!isAuthorized(req, supabaseServiceKey)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    // ──────────────────────────────────────────
    // Parse and validate payload
    // ──────────────────────────────────────────
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON in request body' }, 400);
    }

    const validation = validatePayload(body);
    if (!validation.valid) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const { type, userId, data } = validation.payload;

    // ──────────────────────────────────────────
    // Create Supabase admin client
    // ──────────────────────────────────────────
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ──────────────────────────────────────────
    // Rate limit check
    // ──────────────────────────────────────────
    const withinRateLimit = await checkRateLimit(supabase, userId);
    if (!withinRateLimit) {
      return jsonResponse(
        {
          error: 'Rate limit exceeded',
          message: `Maximum ${RATE_LIMIT_PER_HOUR} notifications per user per hour`,
        },
        429
      );
    }

    // ──────────────────────────────────────────
    // Fetch active device tokens
    // ──────────────────────────────────────────
    const tokens = await getActiveDeviceTokens(supabase, userId);

    if (tokens.length === 0) {
      return jsonResponse(
        {
          success: false,
          message: 'No active device tokens found for user',
          deviceCount: 0,
          successCount: 0,
          failureCount: 0,
        } satisfies NotificationResponse,
        200
      );
    }

    // ──────────────────────────────────────────
    // Check notification preferences
    // ──────────────────────────────────────────
    const prefResult = await checkNotificationPreferences(supabase, userId, type);

    // Build payload early (needed for logging even if suppressed)
    const payload = buildNotificationPayload(type, data);

    // Calculate priority score for smart filtering
    const calculatedPriority = calculatePriority(type, data);

    // Check basic preferences first (push disabled, type disabled, quiet hours)
    if (!prefResult.shouldSend) {
      // Log suppressed notification for analytics
      await logNotificationEvent(
        supabase,
        userId,
        type,
        payload.title,
        payload.body,
        calculatedPriority,
        prefResult.priorityThreshold,
        false,
        prefResult.suppressionReason,
        data
      );

      return jsonResponse(
        {
          success: false,
          message: `Notification blocked: ${prefResult.suppressionReason || 'user preferences'}`,
          deviceCount: tokens.length,
          successCount: 0,
          failureCount: 0,
        } satisfies NotificationResponse,
        200
      );
    }

    // ──────────────────────────────────────────
    // Smart priority filtering (Pro+ only)
    // ──────────────────────────────────────────
    const subscription = await getUserSubscription(supabase, userId);
    const passedPriorityFilter = shouldSendBasedOnPriority(
      calculatedPriority,
      prefResult.priorityThreshold,
      subscription
    );

    if (!passedPriorityFilter) {
      // Log suppressed notification for analytics
      await logNotificationEvent(
        supabase,
        userId,
        type,
        payload.title,
        payload.body,
        calculatedPriority,
        prefResult.priorityThreshold,
        false,
        'priority_threshold',
        data
      );

      return jsonResponse(
        {
          success: false,
          message: `Notification filtered by priority (${calculatedPriority} > threshold ${prefResult.priorityThreshold})`,
          deviceCount: tokens.length,
          successCount: 0,
          failureCount: 0,
          filtered: true,
          priority: calculatedPriority,
          threshold: prefResult.priorityThreshold,
        } as unknown as NotificationResponse,
        200
      );
    }

    // ──────────────────────────────────────────
    // Send via Expo Push API
    // ──────────────────────────────────────────
    const result = await sendExpoPushNotifications(tokens, {
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: payload.sound,
      priority: payload.priority,
      channelId: payload.channelId,
    });

    // ──────────────────────────────────────────
    // Deactivate invalid tokens
    // ──────────────────────────────────────────
    if (result.invalidTokens.length > 0) {
      await deactivateInvalidTokens(supabase, result.invalidTokens);
    }

    // ──────────────────────────────────────────
    // Log delivery to audit_log and notification_logs
    // ──────────────────────────────────────────
    await logNotificationDelivery(supabase, userId, type, result);

    // Log successful send to notification_logs for analytics
    await logNotificationEvent(
      supabase,
      userId,
      type,
      payload.title,
      payload.body,
      calculatedPriority,
      prefResult.priorityThreshold,
      true,
      null,
      data
    );

    // ──────────────────────────────────────────
    // Update last_used_at on device tokens
    // ──────────────────────────────────────────
    // WHY update last_used_at: Helps identify stale tokens that haven't
    // received a notification in a long time, enabling periodic cleanup
    // of tokens from devices that may have uninstalled without deregistering.
    const activeTokens = tokens.filter(
      (t) => !result.invalidTokens.includes(t)
    );
    if (activeTokens.length > 0) {
      await supabase
        .from('device_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .in('token', activeTokens);
    }

    // ──────────────────────────────────────────
    // Return response
    // ──────────────────────────────────────────
    const response: NotificationResponse = {
      success: result.successCount > 0,
      message:
        result.failureCount === 0
          ? `Notification sent to ${result.successCount} device(s)`
          : `Sent to ${result.successCount} device(s), ${result.failureCount} failed`,
      deviceCount: result.totalSent,
      successCount: result.successCount,
      failureCount: result.failureCount,
    };

    return jsonResponse(response as unknown as Record<string, unknown>, 200);
  } catch (error) {
    // WHY generic error message: Internal errors may contain sensitive
    // information (database connection strings, stack traces, etc.) that
    // should not be exposed to callers, even trusted internal services.
    // The full error is logged server-side for debugging.
    console.error('Push notification error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
