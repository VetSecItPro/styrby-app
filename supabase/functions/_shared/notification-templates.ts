/**
 * Notification Templates Shared Module
 *
 * Pure-function templates and lookup tables for the send-push-notification
 * edge function. Extracted out of `send-push-notification/index.ts` so that:
 *
 * 1. The pure logic (no I/O, no Supabase, no Deno globals) can be unit-tested
 *    from Node/Vitest without standing up a Deno test runner.
 * 2. Multiple call sites (the function body, future test consumers, possible
 *    future API routes) reference the same source of truth for event types
 *    and per-event behavior.
 *
 * What lives here:
 * - `NotificationEventType` — union of all push event types
 * - `NotificationEventData` — per-event data payload shape
 * - `NotificationPayload` — return shape from buildNotificationPayload
 * - `NotificationPreferences` — user-pref row shape (subset relevant here)
 * - `BASE_PRIORITY_BY_EVENT` — 1-5 urgency lookup
 * - `VALID_EVENT_TYPES` — runtime allowlist used for payload validation
 * - `isTypeAllowed()` — maps event type → relevant `push_*` preference toggle
 * - `buildNotificationPayload()` — title/body/data/priority template per type
 *
 * What does NOT live here:
 * - The Deno HTTP handler (auth, rate limit, audit log, Expo HTTP call)
 * - Smart-priority scoring (cost thresholds, risk adjustments) — those live
 *   in index.ts because they read from auxiliary lookups not relevant to
 *   template rendering itself.
 *
 * @see supabase/functions/send-push-notification/index.ts for the consumer
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Notification event types accepted by send-push-notification.
 *
 * Each type maps to a specific notification template (title + body), a base
 * priority score, and a preference column in `notification_preferences` that
 * gates whether the push fires. Adding a new event type requires updating:
 *   1. This union
 *   2. `VALID_EVENT_TYPES` runtime allowlist
 *   3. `BASE_PRIORITY_BY_EVENT` priority lookup
 *   4. `isTypeAllowed()` preference mapping
 *   5. `buildNotificationPayload()` template
 * The exhaustive `never` check at the bottom of buildNotificationPayload
 * makes step 5 a compile error if forgotten.
 */
export type NotificationEventType =
  | 'permission_request'
  | 'session_started'
  | 'session_completed'
  | 'session_error'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'approval_request'
  | 'cloud_task_completed'
  | 'cloud_task_failed';

/**
 * Per-event data payload. Not all fields apply to every event — the template
 * builder pulls only what it needs and falls back to defaults.
 */
export interface NotificationEventData {
  sessionId?: string;
  agentType?: string;
  approvalId?: string;
  requesterUserId?: string;
  actions?: string[];
  title?: string;
  body?: string;
  costUsd?: number;
  budgetThreshold?: number;
  permissionType?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  toolName?: string;
  sessionDurationMs?: number;
  // #97 PR-3 — cloud_task_* fields
  taskId?: string;
  prompt?: string;
}

/**
 * The Expo push payload shape returned by `buildNotificationPayload`.
 */
export interface NotificationPayload {
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default' | null;
  priority: 'default' | 'high';
  /** Optional Android notification channel ID for routing to specific UX */
  channelId?: string;
}

/**
 * Subset of `notification_preferences` columns relevant to template logic.
 * The full row shape lives in index.ts — duplicating here would be drift
 * risk; importing from index.ts would create a circular boundary. The
 * compromise: declare the minimum surface needed here, callers populate
 * from the full row.
 */
export interface NotificationPreferences {
  push_permission_requests: boolean;
  push_session_errors: boolean;
  push_budget_alerts: boolean;
  push_session_complete: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Runtime allowlist for incoming `type` field validation. Mirrors
 * `NotificationEventType` exactly. Drift is caught by `as const` + the
 * type-level satisfies check in the consumer.
 */
export const VALID_EVENT_TYPES: readonly NotificationEventType[] = [
  'permission_request',
  'session_started',
  'session_completed',
  'session_error',
  'budget_warning',
  'budget_exceeded',
  'approval_request',
  'cloud_task_completed',
  'cloud_task_failed',
] as const;

/**
 * Base priority scores by event type.
 * Scale: 1 (most urgent) to 5 (informational only).
 *
 * Smart-priority logic in index.ts adjusts these by risk level, cost, and
 * session duration before comparing against the user's `priority_threshold`.
 */
export const BASE_PRIORITY_BY_EVENT: Record<NotificationEventType, number> = {
  permission_request: 2,
  session_started: 5,
  session_completed: 4,
  session_error: 2,
  budget_warning: 2,
  budget_exceeded: 1,
  // approval_request: maximum urgency — team members are blocked at the CLI
  approval_request: 1,
  // cloud_task_completed: structurally same as session_completed
  cloud_task_completed: 4,
  // cloud_task_failed: agent error is actionable — same priority as session_error
  cloud_task_failed: 2,
};

// ============================================================================
// Preference mapping
// ============================================================================

/**
 * Returns whether the user's preferences allow this notification type.
 *
 * Maps each event type to its corresponding `push_*` column. Types without
 * a dedicated toggle (session_started, approval_request) are always allowed
 * because they're either informational or governance-critical.
 *
 * @param prefs - The user's notification_preferences row (partial shape)
 * @param eventType - The event type to check
 * @returns true if the user has opted in (or no opt-out exists)
 */
export function isTypeAllowed(
  prefs: NotificationPreferences,
  eventType: NotificationEventType,
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
      // No dedicated preference column — informational, low frequency.
      return true;
    case 'approval_request':
      // Cannot be opted out at the type level; SOC2 CC6.3 governance
      // controls must not be user-bypassable.
      return true;
    case 'cloud_task_completed':
      // Reuses push_session_complete. Default false (matches session_completed).
      return prefs.push_session_complete;
    case 'cloud_task_failed':
      // Reuses push_session_errors. Default true.
      return prefs.push_session_errors;
    default: {
      // Exhaustive check — adding a new event type without a case is a
      // compile error here.
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}

// ============================================================================
// Template builder
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
export function buildNotificationPayload(
  type: NotificationEventType,
  data: NotificationEventData,
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

    case 'cloud_task_completed':
      // Tap takes user to the cloud-tasks screen (where the task list and
      // detail sheet live); the taskId is forwarded so the screen can
      // optionally auto-open the matching task on launch.
      return {
        title: data.title || 'Cloud Task Complete',
        body:
          data.body ||
          (data.prompt && data.prompt.length > 0
            ? `${data.agentType || 'Agent'}: ${data.prompt}`
            : data.costUsd !== undefined
              ? `Task finished — cost $${data.costUsd.toFixed(4)}`
              : 'Cloud task finished'),
        data: {
          screen: 'cloud-tasks',
          taskId: data.taskId,
          type: 'cloud_task_completed',
        },
        sound: 'default',
        priority: 'default',
      };

    case 'cloud_task_failed':
      // Priority 'high' on the Expo channel matches session_error so the
      // OS surfaces it more prominently — a failed cloud task is actionable.
      return {
        title: data.title || 'Cloud Task Failed',
        body:
          data.body ||
          (data.prompt && data.prompt.length > 0
            ? `${data.agentType || 'Agent'} failed on: ${data.prompt}`
            : `${data.agentType || 'Agent'} encountered an error`),
        data: {
          screen: 'cloud-tasks',
          taskId: data.taskId,
          type: 'cloud_task_failed',
        },
        sound: 'default',
        priority: 'high',
      };

    case 'budget_warning': {
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

    // Phase 2.4 — approval_request notification.
    // Sent to eligible approvers when the CLI pauses on a review-class command.
    // "Approve / Deny / View diff" is spelled out in the body so notifications
    // remain scannable on watches / previews where action buttons don't appear.
    case 'approval_request':
      return {
        title: data.title || `Approval Required: ${data.toolName || 'Tool call'}`,
        body:
          data.body ||
          `A team member is waiting. Tap to Approve, Deny, or View diff.`,
        data: {
          screen: 'approvals',
          approvalId: data.approvalId,
          requesterUserId: data.requesterUserId,
          toolName: data.toolName,
          riskLevel: data.riskLevel,
          actions: data.actions ?? ['approve', 'deny', 'view_diff'],
          type: 'approval_request',
        },
        sound: 'default',
        priority: 'high',
        channelId: 'permissions',
      };

    default: {
      // Exhaustive check ensures every NotificationEventType is handled.
      const _exhaustiveCheck: never = type;
      throw new Error(`Unhandled notification type: ${String(_exhaustiveCheck)}`);
    }
  }
}
