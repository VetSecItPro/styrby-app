/**
 * Offline Queue Quarantine Service
 *
 * Manages the lifecycle of messages that have repeatedly failed to send.
 * After MAX_RETRIES consecutive failures, a message is promoted to 'quarantined'
 * status so it stops consuming retry cycles and becomes visible for human review.
 *
 * WHY quarantine instead of permanent failure:
 * Without quarantine, messages that hit max_attempts are silently marked 'failed'
 * and forgotten. In a 72-hour offline scenario with 1000+ queued messages, a
 * small category of persistently-bad messages (malformed payload, server-side
 * validation rejection) would continually exhaust retry budget, delaying
 * delivery of healthy messages behind them. Quarantine cleanly separates
 * "won't-ever-succeed" from "hasn't-succeeded-yet" so the queue drains
 * efficiently while giving the user a visible recovery path.
 *
 * Client-only concern:
 * 'quarantined' is a local SQLite state, never written to the Supabase
 * offline_command_queue table. The server table status CHECK constraint
 * accepts only ('pending','sending','sent','failed'), which is correct —
 * the server does not need to know about client-side quarantine decisions.
 */

import * as SQLite from 'expo-sqlite';
import type { RelayMessage } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum consecutive send failures before a message is quarantined.
 *
 * WHY 5: Three attempts (DEFAULT_MAX_ATTEMPTS) covers transient network
 * blips. Five extends that to cover longer outages and server hiccups while
 * keeping the quarantine window tight enough that bad messages don't stall
 * recovery for multi-hour offline periods. Empirically, after 5 attempts with
 * exponential back-off (~1+2+4+8+16 = 31 seconds of delay) a message that
 * still fails is almost certainly structurally bad rather than temporarily
 * unreachable.
 */
export const MAX_RETRIES = 5;

// ============================================================================
// Types
// ============================================================================

/**
 * A message that has been quarantined after MAX_RETRIES consecutive failures.
 * Exposes enough context for a "Review quarantined messages" UI surface.
 */
export interface QuarantinedMessage {
  /** Unique queue item ID (same as the command_queue row ID) */
  id: string;
  /** The relay message payload — needed to display content in review UI */
  message: RelayMessage;
  /** ISO 8601 timestamp when the message was first enqueued */
  createdAt: string;
  /** ISO 8601 timestamp when the message was quarantined */
  quarantinedAt: string;
  /** Last error that caused the final retry to fail */
  lastError: string | undefined;
  /** Total send attempts before quarantine (always >= MAX_RETRIES) */
  attempts: number;
}

// ============================================================================
// Database Helpers
// ============================================================================

/**
 * Lazily-resolved database handle.
 * Shared with offline-queue.ts via the same DB_NAME so both services
 * operate on the same SQLite file and rows.
 *
 * WHY same DB as offline-queue: Quarantine operates on the same
 * command_queue rows — it only changes their status to 'quarantined'.
 * Opening a separate database would require complex cross-DB row
 * references. Using one DB keeps transactions atomic and queries simple.
 */
const DB_NAME = 'styrby_offline_queue.db';
let _db: SQLite.SQLiteDatabase | null = null;

/**
 * Opens (or returns the cached) SQLite database.
 * Ensures the command_queue table exists before any quarantine operation.
 *
 * @returns Resolved database handle
 */
async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  // Ensure the table + quarantine index exist, safe to call repeatedly.
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS command_queue (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_attempt_at TEXT,
      last_error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      quarantined_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_quarantined
      ON command_queue(status)
      WHERE status = 'quarantined';
  `);
  return _db;
}

/**
 * Converts a raw database row to a QuarantinedMessage.
 *
 * @param row - Raw row from command_queue WHERE status = 'quarantined'
 * @returns Typed QuarantinedMessage
 */
function rowToQuarantined(row: Record<string, unknown>): QuarantinedMessage {
  return {
    id: row.id as string,
    message: JSON.parse(row.message as string) as RelayMessage,
    createdAt: row.created_at as string,
    quarantinedAt: row.quarantined_at as string,
    lastError: (row.last_error as string | null) ?? undefined,
    attempts: row.attempts as number,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks if a command has exceeded MAX_RETRIES and, if so, transitions it
 * to 'quarantined' status.
 *
 * Called by the queue's markFailed() path — the queue increments attempts and
 * then calls this to determine whether quarantine should apply instead of
 * returning to 'pending'.
 *
 * WHY separate from markFailed: Keeping quarantine logic here preserves the
 * single-responsibility boundary. The queue manages send lifecycle; the
 * quarantine service manages the "too-many-failures" escalation path.
 *
 * @param id - Queue item ID to inspect
 * @param attempts - Current attempt count (post-increment)
 * @param lastError - Last failure reason
 * @returns `true` if the item was quarantined, `false` if retries remain
 *
 * @example
 * const quarantined = await maybeQuarantine('queue_abc', 5, 'Network timeout');
 * if (quarantined) {
 *   // Item moved to quarantine — do not re-enqueue
 * }
 */
export async function maybeQuarantine(
  id: string,
  attempts: number,
  lastError: string
): Promise<boolean> {
  if (attempts < MAX_RETRIES) return false;

  const db = await getDb();
  const now = new Date().toISOString();

  await db.runAsync(
    `UPDATE command_queue
     SET status = 'quarantined', quarantined_at = ?, last_error = ?
     WHERE id = ? AND status != 'sent'`,
    [now, lastError, id]
  );

  return true;
}

/**
 * Returns all currently quarantined messages, ordered oldest-first.
 *
 * Intended for the "Review quarantined messages" UI surface. Returns the
 * full RelayMessage payload so the UI can show a meaningful preview
 * (message type, content snippet, timestamp).
 *
 * @returns Array of QuarantinedMessage (empty if none)
 *
 * @example
 * const quarantined = await getQuarantined();
 * console.log(`${quarantined.length} messages need review`);
 */
export async function getQuarantined(): Promise<QuarantinedMessage[]> {
  const db = await getDb();

  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM command_queue
     WHERE status = 'quarantined'
     ORDER BY quarantined_at ASC`
  );

  return rows.map(rowToQuarantined);
}

/**
 * Returns only the count of quarantined messages.
 *
 * WHY a dedicated count method: The connectivity banner shows
 * "N quarantined" without needing to deserialize every message payload.
 * This avoids unnecessary JSON.parse for 1000-message queues.
 *
 * @returns Number of quarantined messages
 *
 * @example
 * const count = await getQuarantinedCount();
 * // Show badge if count > 0
 */
export async function getQuarantinedCount(): Promise<number> {
  const db = await getDb();

  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM command_queue WHERE status = 'quarantined'`
  );

  return row?.count ?? 0;
}

/**
 * Re-queues a single quarantined message for another send attempt.
 *
 * Resets attempts to 0 and status to 'pending' so the normal queue
 * processor picks it up on the next processQueue() call.
 *
 * WHY reset attempts to 0: The user explicitly opted in to retry. Keeping
 * attempts at MAX_RETRIES would immediately re-quarantine the message on
 * the first failure. A fresh slate gives the message a full MAX_RETRIES
 * budget, which is the user's intent.
 *
 * @param messageId - ID of the quarantined message to retry
 * @throws Error if the message is not found or already sent
 *
 * @example
 * await retryQuarantined('queue_abc');
 */
export async function retryQuarantined(messageId: string): Promise<void> {
  const db = await getDb();

  const result = await db.runAsync(
    `UPDATE command_queue
     SET status = 'pending',
         attempts = 0,
         quarantined_at = NULL,
         last_error = NULL,
         last_attempt_at = NULL
     WHERE id = ? AND status = 'quarantined'`,
    [messageId]
  );

  if (result.changes === 0) {
    throw new Error(
      `retryQuarantined: no quarantined message with id '${messageId}'`
    );
  }
}

/**
 * Permanently discards a single quarantined message.
 *
 * Use when the user reviews the message and decides it should not be sent
 * (e.g., stale permission response, outdated cancel command).
 *
 * @param messageId - ID of the quarantined message to discard
 * @throws Error if the message is not found or not in quarantined state
 *
 * @example
 * await discardQuarantined('queue_abc');
 */
export async function discardQuarantined(messageId: string): Promise<void> {
  const db = await getDb();

  const result = await db.runAsync(
    `DELETE FROM command_queue WHERE id = ? AND status = 'quarantined'`,
    [messageId]
  );

  if (result.changes === 0) {
    throw new Error(
      `discardQuarantined: no quarantined message with id '${messageId}'`
    );
  }
}

/**
 * Discards all quarantined messages at once.
 *
 * Exposed for bulk-clear UI action ("Discard all quarantined").
 *
 * @returns Number of messages discarded
 *
 * @example
 * const removed = await discardAllQuarantined();
 * console.log(`Discarded ${removed} quarantined messages`);
 */
export async function discardAllQuarantined(): Promise<number> {
  const db = await getDb();

  const result = await db.runAsync(
    `DELETE FROM command_queue WHERE status = 'quarantined'`
  );

  return result.changes;
}

/**
 * Test utility: resets the module-level SQLite db handle so each test
 * starts from a clean state.
 *
 * WHY: The module-level `_db` reference persists across Jest tests within
 * the same file. Calling this in beforeEach ensures the test mock's db
 * instance is used on every test, preventing stale handle bleed.
 *
 * ONLY call from test files — never in production code.
 *
 * @internal
 */
export function __resetDbForTests(): void {
  _db = null;
}
