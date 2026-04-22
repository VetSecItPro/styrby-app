/**
 * Clock-Skew Tolerance for Offline Queue Ordering
 *
 * Mobile devices can drift from real time in several ways:
 *   - User manually sets the clock to a wrong time
 *   - Timezone change (e.g. flying across timezones while offline)
 *   - Daylight-savings edge: iOS/Android may delay DST adjustment until
 *     the next network sync, causing a 1-hour jump on reconnect
 *   - NTP not yet synced after airplane-mode → reconnect
 *
 * WHY this matters for replay ordering: `offline-queue.ts` uses
 * `createdAt` (local wall-clock) for FIFO ordering within the same
 * priority tier. If the device clock is skewed by +3 hours, a message
 * queued at "real" 10:00 AM is stamped 13:00 and appears to be later than
 * a message queued at "real" 11:00 AM that is stamped 11:00 — reversing
 * their correct order.
 *
 * Fix strategy:
 *   1. If the relay server assigns a `serverTimestamp` (NTP-synced),
 *      use it for ordering instead of `localTimestamp`.
 *   2. If the relay backend assigns a monotonic `serverSequence` integer,
 *      prefer that over any timestamp (immune to all clock issues).
 *   3. Fall back to `localTimestamp` only when the server provides neither.
 *
 * This module provides pure functions for this normalization so they can be
 * thoroughly tested without any React or SQLite dependencies.
 *
 * @module services/clock-skew
 */

import type {
  MessageOrderingKey,
  NormalizedOrderingResult,
} from '../types/offline-queue';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum tolerable skew between local and server timestamps.
 *
 * WHY 3 hours: The worst common real-world case is a user flying across
 * timezone boundaries while offline. A 3-hour buffer covers transcontinental
 * flights. Larger skews indicate manual clock tampering or broken NTP and
 * should be flagged for telemetry.
 *
 * Value: 3 hours in milliseconds.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Precision guard: ignore skew smaller than this threshold.
 * Clocks within 1 second of each other are considered synchronized.
 */
const SKEW_DETECTION_THRESHOLD_MS = 1_000;

// ============================================================================
// Core Function
// ============================================================================

/**
 * Normalize a message ordering key to the most reliable timestamp available.
 *
 * Selection priority:
 *   1. `serverSequence` — if present, emit a synthetic ISO timestamp using
 *      the sequence as an offset from Unix epoch (immune to drift, monotonic)
 *   2. `serverTimestamp` — NTP-synced server clock; preferred over local
 *   3. `localTimestamp` — last resort; may be skewed
 *
 * Also computes skew between local and server timestamps for telemetry.
 *
 * @param key - Ordering key with optional server-provided values
 * @param nowMs - Current time in ms (defaults to Date.now(); injected for testing)
 * @returns NormalizedOrderingResult with the chosen timestamp and diagnostics
 *
 * @example
 * // Server provided a sequence number:
 * const result = normalizeOrderingTimestamp({
 *   serverSequence: 42,
 *   localTimestamp: new Date().toISOString(),
 * });
 * // result.source === 'serverSequence'
 * // result.timestamp === new Date(42).toISOString()
 *
 * @example
 * // Server provided a timestamp (±3h skew tolerated):
 * const result = normalizeOrderingTimestamp({
 *   serverTimestamp: '2026-04-21T10:00:00.000Z',
 *   localTimestamp: '2026-04-21T13:00:00.000Z', // 3h skew
 * });
 * // result.source === 'serverTimestamp'
 * // result.skewDetected === true
 * // result.skewMs === 10_800_000
 */
export function normalizeOrderingTimestamp(
  key: MessageOrderingKey,
  nowMs = Date.now()
): NormalizedOrderingResult {
  // WHY serverSequence first: A monotonic counter assigned by the relay backend
  // is entirely immune to clock skew. We convert it to an ISO string by using
  // it as ms-since-epoch so the result type is consistent with timestamp-based
  // ordering downstream (string ISO comparison still yields correct order since
  // sequences increase monotonically and the epoch offsets reflect that).
  if (key.serverSequence !== undefined) {
    return {
      timestamp: new Date(key.serverSequence).toISOString(),
      source: 'serverSequence',
      skewDetected: false,
      skewMs: 0,
    };
  }

  if (key.serverTimestamp) {
    const serverMs = new Date(key.serverTimestamp).getTime();
    const localMs = new Date(key.localTimestamp).getTime();

    // Detect skew between local and server clocks
    const skewMs = Math.abs(localMs - serverMs);
    const skewDetected = skewMs > SKEW_DETECTION_THRESHOLD_MS;

    // Use server timestamp regardless of skew magnitude — it is always more
    // reliable than local for ordering. We surface skewDetected so the caller
    // can emit a Sentry breadcrumb or telemetry event when skew is large.
    return {
      timestamp: key.serverTimestamp,
      source: 'serverTimestamp',
      skewDetected,
      skewMs,
    };
  }

  // Fall back to local timestamp
  return {
    timestamp: key.localTimestamp,
    source: 'local',
    skewDetected: false,
    skewMs: 0,
  };
}

// ============================================================================
// Comparison Utilities
// ============================================================================

/**
 * Compare two messages by their normalized ordering timestamps.
 *
 * Resolves each key via `normalizeOrderingTimestamp`, then compares
 * the resulting ISO strings lexicographically (which is equivalent to
 * chronological order for ISO 8601 format).
 *
 * Use as a comparator in `Array.prototype.sort()` to sort a batch of
 * queued messages into correct replay order before processing.
 *
 * @param a - Ordering key for the first message
 * @param b - Ordering key for the second message
 * @returns Negative if a < b, 0 if equal, positive if a > b
 *
 * @example
 * const sorted = messages.sort((a, b) =>
 *   compareMessageOrder(a.orderingKey, b.orderingKey)
 * );
 */
export function compareMessageOrder(
  a: MessageOrderingKey,
  b: MessageOrderingKey
): number {
  const normA = normalizeOrderingTimestamp(a);
  const normB = normalizeOrderingTimestamp(b);
  return normA.timestamp.localeCompare(normB.timestamp);
}

/**
 * Build a MessageOrderingKey from the relay message fields available at
 * enqueue time.
 *
 * WHY: The relay server may include a `server_sequence` or `server_timestamp`
 * in the ACK it sends back after accepting a message. This function provides
 * a single place to construct the key from whatever fields are available,
 * ensuring consistent precedence across enqueue paths.
 *
 * @param localTimestamp - Local wall-clock ISO timestamp (from Date.now())
 * @param serverTimestamp - ISO timestamp from relay server ACK (optional)
 * @param serverSequence - Monotonic integer from relay server ACK (optional)
 * @returns A MessageOrderingKey ready for normalizeOrderingTimestamp
 *
 * @example
 * // On message enqueue (server has not responded yet):
 * const key = buildOrderingKey(new Date().toISOString());
 *
 * // After server ACK (update the stored key):
 * const key = buildOrderingKey(
 *   originalLocalTs,
 *   ack.server_timestamp,
 *   ack.server_sequence
 * );
 */
export function buildOrderingKey(
  localTimestamp: string,
  serverTimestamp?: string,
  serverSequence?: number
): MessageOrderingKey {
  const key: MessageOrderingKey = { localTimestamp };
  if (serverTimestamp !== undefined) key.serverTimestamp = serverTimestamp;
  if (serverSequence !== undefined) key.serverSequence = serverSequence;
  return key;
}

/**
 * Determine whether the local clock appears to be skewed relative to a
 * reference server timestamp.
 *
 * Returns true when |local - server| > CLOCK_SKEW_TOLERANCE_MS (3 hours).
 * Used by the queue processor to emit a Sentry breadcrumb when severe skew
 * is detected, signaling that replay order may have been affected for
 * messages queued before the correction.
 *
 * @param localMs - Local time in milliseconds (from Date.now())
 * @param serverTimestamp - ISO timestamp from the relay server
 * @returns True if skew exceeds the 3-hour tolerance
 *
 * @example
 * if (isCriticallySkewed(Date.now(), ack.server_timestamp)) {
 *   Sentry.addBreadcrumb({ category: 'clock-skew', level: 'warning' });
 * }
 */
export function isCriticallySkewed(
  localMs: number,
  serverTimestamp: string
): boolean {
  const serverMs = new Date(serverTimestamp).getTime();
  return Math.abs(localMs - serverMs) > CLOCK_SKEW_TOLERANCE_MS;
}
