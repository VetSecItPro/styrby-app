/**
 * Reconnect Notifier
 *
 * Subscribes to AgentSession's `reconnected-after-offline` event and sends a
 * low-priority push notification to the user's phone so they know the daemon
 * is back online after an extended offline period.
 *
 * ## Design constraints
 *
 * - Calls the existing `send-push-notification` Supabase Edge Function — no
 *   new infrastructure needed.
 * - Throttles to at most one notification per session per 30 minutes so that
 *   flaky networks (rapid connect/disconnect cycles) don't spam the user.
 * - Silently skips if the user has no push token (no token → no notification,
 *   not an error).
 * - Absorbs send-push 5xx and timeout errors without crashing the daemon.
 *
 * @module session/reconnectNotifier
 */

import { logger } from '@/ui/logger';
import { config } from '@/env';
import type { AgentSession } from './agent-session';
import type { AgentType } from '@/auth/agent-credentials';

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum gap between reconnect push notifications for the same session.
 *
 * WHY 30 minutes: On flaky networks a session can drop and reconnect several
 * times per hour. Sending a "you're back online" push on every reconnect
 * would be worse than no notification at all. 30 minutes is long enough that
 * a second notification always represents a genuinely new offline episode
 * (the user moved to a different location, not a momentary blip the 5-minute
 * OFFLINE_THRESHOLD_MS filter already handles).
 */
export const THROTTLE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ============================================================================
// Types
// ============================================================================

/**
 * Context required by the notifier to call the send-push edge function.
 */
export interface ReconnectNotifierConfig {
  /** Supabase user ID — used to look up device tokens in send-push. */
  userId: string;
  /** Agent type label used in the notification body copy. */
  agent: AgentType;
  /** Session UUID used as a deep-link payload in the notification data. */
  sessionId: string;
  /** Machine ID forwarded as context in the notification data. */
  machineId: string;
}

/**
 * Shape of the request body sent to the send-push-notification edge function.
 */
interface SendPushBody {
  type: string;
  userId: string;
  data: {
    title: string;
    body: string;
    sessionId: string;
    machineId: string;
    agentType: string;
    type: 'daemon_reconnected';
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats offline duration into a human-readable string for notification body.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable string, e.g. "5 minutes", "1 hour 12 minutes"
 */
function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes !== 1 ? 's' : ''}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourPart = `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (minutes === 0) return hourPart;
  return `${hourPart} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

// ============================================================================
// In-Memory Throttle Map
// ============================================================================

/**
 * Maps `sessionId -> last notification timestamp (ms epoch)`.
 *
 * WHY in-memory map keyed on sessionId: The daemon process is long-lived and
 * holds a single AgentSession per invocation. An in-memory map is the simplest
 * correct solution — no disk I/O, no Supabase round-trip, no race condition
 * (Node.js event loop is single-threaded). The map is keyed on `sessionId`
 * (not userId or machineId) because we want per-session throttling: two
 * concurrent sessions on the same machine should each get their own 30-min
 * window independently.
 */
const lastNotifiedAt: Map<string, number> = new Map();

/**
 * Check if a push notification for this session is within the throttle window.
 *
 * @param sessionId - Session UUID to check
 * @returns true if we should suppress the notification (too soon)
 */
function isThrottled(sessionId: string): boolean {
  const last = lastNotifiedAt.get(sessionId);
  if (last === undefined) return false;
  return Date.now() - last < THROTTLE_WINDOW_MS;
}

/**
 * Record a notification send for throttle tracking.
 *
 * @param sessionId - Session UUID that was notified
 */
function recordNotification(sessionId: string): void {
  lastNotifiedAt.set(sessionId, Date.now());
}

// ============================================================================
// Push Delivery
// ============================================================================

/**
 * Calls the `send-push-notification` Supabase Edge Function to deliver the
 * reconnect notification.
 *
 * Uses the STYRBY_SERVICE_ROLE_KEY environment variable for authorization.
 * If the key is missing, the function logs a warning and skips silently —
 * this is expected in local development where push notifications are not
 * configured.
 *
 * @param ctx - Notifier configuration context
 * @param offlineDurationMs - How long the daemon was offline (for copy)
 * @returns true if the HTTP request was made (regardless of response status)
 */
async function callSendPush(
  ctx: ReconnectNotifierConfig,
  offlineDurationMs: number
): Promise<boolean> {
  const serviceKey = process.env.STYRBY_SERVICE_ROLE_KEY;

  if (!serviceKey) {
    // WHY: Service role key is required for the edge function. In dev/CI
    // environments that don't configure push, silently skip rather than
    // crash the daemon.
    logger.debug('[ReconnectNotifier] STYRBY_SERVICE_ROLE_KEY not set — skipping push');
    return false;
  }

  const edgeFunctionUrl = `${config.supabaseUrl}/functions/v1/send-push-notification`;

  const durationStr = formatDuration(offlineDurationMs);
  const agentLabel = ctx.agent.charAt(0).toUpperCase() + ctx.agent.slice(1);

  const body: SendPushBody = {
    type: 'session_started', // Reuses existing allowed type; routing is driven by data.type
    userId: ctx.userId,
    data: {
      // Explicit title/body overrides let send-push pass them through directly
      title: 'Styrby is back online',
      body: `Your ${agentLabel} session is connected after ${durationStr}. Tap to resume.`,
      sessionId: ctx.sessionId,
      machineId: ctx.machineId,
      agentType: ctx.agent,
      type: 'daemon_reconnected',
    },
  };

  try {
    const res = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(body),
      // WHY 10-second timeout: Push notifications are best-effort. If the
      // edge function is slow or unreachable, we should not block the daemon's
      // event loop or cause timeouts that cascade into reconnect failures.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.debug('[ReconnectNotifier] send-push returned non-OK status', {
        status: res.status,
        sessionId: ctx.sessionId,
      });
    }

    return true;
  } catch (err) {
    // WHY absorb errors: Push delivery is best-effort. A 5xx, network error,
    // or timeout must never crash the daemon or surface to the user as a
    // session error. We log at debug level only.
    logger.debug('[ReconnectNotifier] send-push call failed (absorbed)', {
      err: err instanceof Error ? err.message : String(err),
      sessionId: ctx.sessionId,
    });
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Wires up the reconnect push notification trigger to an AgentSession.
 *
 * Should be called once per session immediately after the session is created,
 * before `start()` is invoked. The returned cleanup function unsubscribes the
 * event listener — call it when the session is destroyed if needed (in
 * practice the session EventEmitter is garbage-collected with the daemon
 * process so cleanup is optional but provided for correctness).
 *
 * @param session - The AgentSession to observe
 * @param ctx - Notifier configuration (userId, agent, sessionId, machineId)
 * @returns Cleanup function that removes the event listener
 *
 * @example
 * const session = new AgentSession(config);
 * const cleanup = attachReconnectNotifier(session, {
 *   userId: config.userId,
 *   agent: config.agent,
 *   sessionId: session.getSessionId(), // Set after start()
 *   machineId: config.machineId,
 * });
 * await session.start();
 * // ...
 * cleanup(); // optional
 */
export function attachReconnectNotifier(
  session: AgentSession,
  ctx: ReconnectNotifierConfig
): () => void {
  /**
   * Handler invoked when the session has been offline > OFFLINE_THRESHOLD_MS
   * and has just successfully reconnected.
   */
  const handler = ({ offlineDurationMs }: { offlineDurationMs: number }) => {
    const sessionId = ctx.sessionId || session.getSessionId();

    // Throttle: skip if we already notified within the last THROTTLE_WINDOW_MS
    if (isThrottled(sessionId)) {
      logger.debug('[ReconnectNotifier] throttled — skipping push', {
        sessionId,
        offlineDurationMs,
      });
      return;
    }

    // Record before the async send so that parallel events (rare but possible)
    // don't race past the throttle check.
    recordNotification(sessionId);

    // Use the live sessionId from the session in case it was not yet set when
    // the notifier was attached (i.e. called before start() completed).
    const liveCtx: ReconnectNotifierConfig = {
      ...ctx,
      sessionId,
    };

    callSendPush(liveCtx, offlineDurationMs).catch((err) => {
      logger.debug('[ReconnectNotifier] unexpected error in callSendPush', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  session.on('reconnected-after-offline', handler);

  return () => {
    session.off('reconnected-after-offline', handler);
  };
}

export default { attachReconnectNotifier };
