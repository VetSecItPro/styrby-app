/**
 * safeRelaySend — uniform error-handling wrapper for outbound relay sends
 *
 * WHY (B4-Wave2 — error-handling completeness): The bridge in apiSession.ts
 * has ~10 sites that call `api.sendSessionState(...)` / `api.sendAgentResponse(...)` /
 * `api.sendPermissionRequest(...)` and chain `.catch(() => {})` or
 * `.catch((e) => logger.debug(...))`. The relay is the critical path for
 * mobile <-> CLI communication; silent send failures cause:
 *   - mobile UI never learning the agent finished a tool
 *   - permission-request prompts never reaching the user (agent appears hung)
 *   - session-state transitions invisible to the user
 *
 * Switching every site to a uniform wrapper buys:
 *   1. **One place to upgrade logging** (warn instead of debug; context attached)
 *   2. **One place to add Sentry capture** later (single import, single tag set)
 *   3. **Consistent context shape** so log scrapers can group failures
 *   4. **Telemetry hook** for future `relay.send_failed` metric emission
 *
 * The wrapper NEVER rethrows — callers don't need to defensively `.catch()`
 * around it. The return value is a discriminated union so callers that DO
 * want to react (e.g. fall back to a different transport) can switch on it.
 *
 * @module api/safeRelaySend
 */

import { logger } from '@/ui/logger';

/**
 * Categorical message types we send through the relay. Used for log
 * grouping + future telemetry tags.
 */
export type RelayMessageCategory =
  | 'session-state'
  | 'agent-response'
  | 'permission-request'
  | 'session-state-error'
  | 'unknown';

/**
 * Context attached to every safeRelaySend call. Becomes the second
 * argument to logger.warn so log scrapers can group + filter.
 */
export interface SafeRelaySendContext {
  /** Session the message belongs to (for cross-correlation with mobile logs). */
  sessionId: string;
  /** Categorical send type — drives telemetry grouping. */
  messageType: RelayMessageCategory;
  /** Optional: secondary qualifier (e.g. relay state 'idle' / 'executing'). */
  detail?: string;
}

/**
 * Result of a safeRelaySend call. Discriminated on `ok`.
 *
 * Success: `{ ok: true; result: T }` — the resolved value of the send promise
 * Failure: `{ ok: false; error: unknown }` — the original rejection (already logged)
 *
 * Callers that don't care about the result can ignore the return value entirely
 * (the wrapper still logs + would emit telemetry). Callers that DO care can
 * switch on `result.ok` without any try/catch boilerplate.
 */
export type SafeRelaySendResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: unknown };

/**
 * Wrap a relay-send promise so its rejection becomes a structured logger.warn
 * call (instead of a silent `.catch(() => {})` or low-signal `logger.debug`).
 *
 * Always resolves; never rejects. Caller does not need a `.catch()`.
 *
 * @param send - The promise returned by an `api.send*(...)` call.
 * @param context - Session + categorization metadata for the log line.
 * @returns A discriminated-union result.
 *
 * @example
 *   await safeRelaySend(
 *     api.sendSessionState(sessionId, agentType, 'idle'),
 *     { sessionId, messageType: 'session-state', detail: 'idle' }
 *   );
 */
export async function safeRelaySend<T>(
  send: Promise<T>,
  context: SafeRelaySendContext
): Promise<SafeRelaySendResult<T>> {
  try {
    const result = await send;
    return { ok: true, result };
  } catch (error: unknown) {
    logger.warn('Relay send failed', {
      sessionId: context.sessionId,
      messageType: context.messageType,
      detail: context.detail,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error };
  }
}
