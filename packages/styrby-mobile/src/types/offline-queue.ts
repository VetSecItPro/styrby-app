/**
 * Offline Queue Type Definitions
 *
 * Shared types for the quarantine panel UI, the useQuarantine hook, and the
 * stress test harness. Centralizing here ensures the component, hook, and
 * tests all operate on the same data contract.
 *
 * WHY a dedicated types file: Per CLAUDE.md Component-First Architecture,
 * shared domain types live in `src/types/{domain}.ts` — never inline across
 * multiple component files. This prevents type drift and simplifies imports.
 */

import type { QueuedCommand } from 'styrby-shared';

// ============================================================================
// Quarantine Types
// ============================================================================

/**
 * A failed queue entry surfaced for user review.
 *
 * Extends QueuedCommand with UI display helpers computed at read time
 * to avoid re-computing them inside the component on every render.
 *
 * WHY a separate type vs. QueuedCommand directly: `QuarantinedMessage` is
 * owned by the UI layer. Adding display fields (humanReadableError, ageMs)
 * to QueuedCommand would pollute the domain model in styrby-shared.
 */
export interface QuarantinedMessage {
  /** The underlying failed command from the offline queue */
  command: QueuedCommand;
  /**
   * Human-readable error string for display in the quarantine panel.
   * Derived from command.lastError, with a fallback for unknown errors.
   */
  humanReadableError: string;
  /**
   * Age of the message in milliseconds, relative to render time.
   * Computed once when the list is loaded; not live-updated.
   */
  ageMs: number;
}

/**
 * Return shape of the useQuarantine hook.
 *
 * Separates read state from action callbacks so the component can
 * destructure only what it needs.
 */
export interface UseQuarantineReturn {
  /** Messages that failed all retry attempts and await user review */
  messages: QuarantinedMessage[];
  /**
   * Whether the quarantine list is currently loading from the queue.
   * True only during the initial fetch; false after first render.
   */
  isLoading: boolean;
  /**
   * Any error encountered while loading the quarantine list.
   * Null when healthy.
   */
  error: string | null;
  /**
   * Retry a single quarantined message.
   * Resets its attempt count to 0, status to 'pending', and re-enqueues it.
   *
   * @param id - The queue item ID to retry
   */
  retryMessage: (id: string) => Promise<void>;
  /**
   * Discard (permanently delete) a single quarantined message.
   * Irreversible — the user has reviewed and confirmed discard.
   *
   * @param id - The queue item ID to discard
   */
  discardMessage: (id: string) => Promise<void>;
  /**
   * Discard all quarantined messages at once.
   * Irreversible — presents a confirmation dialog before calling.
   */
  discardAll: () => Promise<void>;
  /**
   * Retry all quarantined messages.
   * Resets all failed items to pending for a fresh send attempt.
   */
  retryAll: () => Promise<void>;
}

// ============================================================================
// Clock-Skew Types
// ============================================================================

/**
 * Ordering key for a queued message.
 *
 * WHY a dedicated type: When the server assigns a sequence number or
 * timestamp, that must take precedence over local wall-clock `Date.now()`
 * for ordering. Encapsulating the source alongside the value makes the
 * preference logic auditable and testable.
 *
 * Clock-skew rule (enforced in normalizeOrderingTimestamp):
 *   1. If `serverSequence` is present, use it (monotonic, drift-free).
 *   2. If `serverTimestamp` is present, use it (NTP-synced server clock).
 *   3. Fall back to `localTimestamp` (may be skewed by ±3h or more).
 */
export interface MessageOrderingKey {
  /**
   * Server-assigned monotonic sequence number.
   * Present when the relay backend echoes back a per-channel sequence.
   * Most reliable ordering source — immune to clock skew.
   */
  serverSequence?: number;
  /**
   * Server-assigned ISO timestamp.
   * Present when the server tags the message with its own clock.
   * Preferred over localTimestamp but may lag by network RTT.
   */
  serverTimestamp?: string;
  /**
   * Local wall-clock timestamp at enqueue time.
   * Always present; used as last-resort fallback.
   * Susceptible to timezone changes, DST edge, and NTP drift.
   */
  localTimestamp: string;
}

/**
 * Result of normalizing an ordering key to a comparable value.
 */
export interface NormalizedOrderingResult {
  /** The ISO timestamp to use for ordering comparisons */
  timestamp: string;
  /**
   * Which source was selected.
   *
   * WHY expose the source: Tests and observability can verify that the
   * server timestamp was used when expected, and the fallback was chosen
   * when the server did not provide one.
   */
  source: 'serverSequence' | 'serverTimestamp' | 'local';
  /**
   * Whether clock skew was detected (local vs. server timestamp differed
   * by more than CLOCK_SKEW_TOLERANCE_MS).
   * Useful for telemetry — if skew is detected frequently, NTP may be broken.
   */
  skewDetected: boolean;
  /**
   * Detected skew magnitude in milliseconds (|local - server|).
   * Zero when no server timestamp was available for comparison.
   */
  skewMs: number;
}
