/**
 * Lamport Logical Clock for Offline Queue Conflict Resolution
 *
 * A Lamport clock is a monotonic logical counter used to impose a total
 * ordering on events across distributed processes without requiring
 * synchronized wall clocks.
 *
 * Rules (from Lamport 1978, "Time, Clocks, and the Ordering of Events in a
 * Distributed System"):
 *   - On every local send event: clock = clock + 1
 *   - On every remote message receipt: clock = max(local, remote) + 1
 *   - Every message carries its sender's clock at send time
 *
 * WHY we need this for Styrby: When a user sends a message from the mobile
 * app AND the CLI echoes a response at the same wall-clock second (to the
 * nearest millisecond), the `created_at` values in session_messages are
 * equal. Without a tiebreaker, replay order depends on insert order in
 * Postgres (which is undefined after concurrent transactions). Adding
 * `(created_at, lamport_clock, id)` as the sort key gives us deterministic
 * replay across all server restarts and client reconnects.
 *
 * Persistence: The Lamport clock value is stored in SQLite between app
 * launches so it never goes backward. We initialize from the DB on boot and
 * write back after each increment.
 *
 * @module services/lamport-clock
 */

import * as SQLite from 'expo-sqlite';

// ============================================================================
// Constants
// ============================================================================

/** SQLite table name for the single-row clock persistence store */
const CLOCK_TABLE = 'lamport_clock_state';

/** Row ID for the single clock row (we only ever have one) */
const CLOCK_ROW_ID = 1;

// ============================================================================
// Lamport Clock Implementation
// ============================================================================

/**
 * Persistent Lamport logical clock.
 *
 * The clock value is persisted to SQLite so it survives app restarts.
 * Monotonicity is guaranteed: the value never decreases across the lifetime
 * of the app installation.
 *
 * All methods are async because they interact with SQLite. The singleton
 * `lamportClock` handles initialization lazily on first access.
 */
export class LamportClock {
  private current = 0;
  private initialized = false;

  /**
   * Initialize the clock from the persisted value in SQLite.
   * Creates the clock table if it does not exist.
   *
   * Called automatically on first `tick()` or `receive()` — callers do not
   * need to call this directly.
   *
   * @param db - Open SQLite database handle (from the offline queue DB)
   */
  async init(db: SQLite.SQLiteDatabase): Promise<void> {
    if (this.initialized) return;

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${CLOCK_TABLE} (
        id INTEGER PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );

      -- Upsert the single clock row with a zero value on first boot
      INSERT OR IGNORE INTO ${CLOCK_TABLE} (id, value) VALUES (${CLOCK_ROW_ID}, 0);
    `);

    const row = await db.getFirstAsync<{ value: number }>(
      `SELECT value FROM ${CLOCK_TABLE} WHERE id = ?`,
      [CLOCK_ROW_ID]
    );

    // WHY Math.max: If the in-memory value is somehow ahead (shouldn't happen
    // with correct usage but defensive), we never go backward.
    this.current = Math.max(this.current, row?.value ?? 0);
    this.initialized = true;
  }

  /**
   * Advance the clock for a local send event and return the new value.
   *
   * Must be called BEFORE generating the message (so the clock value is
   * embedded in the message that goes to the server). If called after, the
   * server would receive a stale clock value and ordering would be wrong.
   *
   * @param db - Open SQLite database handle
   * @returns The new clock value to embed in the outgoing message
   * @throws Error if the DB write fails (non-quota errors only)
   *
   * @example
   * // Correct usage — tick BEFORE building the message payload:
   * const clockValue = await lamportClock.tick(db);
   * const payload = { ...message, lamport_clock: clockValue };
   * await sendToServer(payload);
   */
  async tick(db: SQLite.SQLiteDatabase): Promise<number> {
    await this.init(db);

    // Advance monotonically
    this.current += 1;

    // Persist the new value. WHY immediate write: If the app is killed after
    // tick() but before the message is sent, on boot the clock resumes from
    // the persisted value (which is ahead of the un-sent message's clock).
    // The un-sent message's clock value will be <= the next tick value,
    // meaning the retry will not advance the clock backward.
    await db.runAsync(
      `UPDATE ${CLOCK_TABLE} SET value = ? WHERE id = ?`,
      [this.current, CLOCK_ROW_ID]
    );

    return this.current;
  }

  /**
   * Update the clock on receipt of a remote message carrying a Lamport value.
   *
   * Implements the Lamport receive rule: clock = max(local, remote) + 1.
   * Ensures our local clock is always ahead of any received clock value.
   *
   * @param db - Open SQLite database handle
   * @param remoteValue - The lamport_clock value carried by the incoming message
   * @returns The updated local clock value
   *
   * @example
   * // When processing an incoming message from the CLI relay:
   * const updatedClock = await lamportClock.receive(db, incomingMsg.lamport_clock);
   */
  async receive(db: SQLite.SQLiteDatabase, remoteValue: number): Promise<number> {
    await this.init(db);

    // Lamport receive rule: advance past the remote value
    this.current = Math.max(this.current, remoteValue) + 1;

    await db.runAsync(
      `UPDATE ${CLOCK_TABLE} SET value = ? WHERE id = ?`,
      [this.current, CLOCK_ROW_ID]
    );

    return this.current;
  }

  /**
   * Read the current clock value without advancing it.
   *
   * WHY: Tests need to inspect the clock value without side effects.
   * In production code, always use `tick()` before a send.
   *
   * @param db - Open SQLite database handle
   * @returns The current clock value
   */
  async peek(db: SQLite.SQLiteDatabase): Promise<number> {
    await this.init(db);
    return this.current;
  }

  /**
   * Reset the clock to zero (for testing only).
   *
   * WHY only for tests: Resetting a Lamport clock in production would allow
   * new messages to carry clock values lower than already-delivered messages,
   * breaking the deterministic ordering guarantee.
   *
   * @param db - Open SQLite database handle
   * @internal
   */
  async _resetForTesting(db: SQLite.SQLiteDatabase): Promise<void> {
    this.current = 0;
    this.initialized = false;
    await db.runAsync(
      `UPDATE ${CLOCK_TABLE} SET value = 0 WHERE id = ?`,
      [CLOCK_ROW_ID]
    );
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton Lamport clock instance for the offline queue.
 *
 * All queue messages share this single clock so that the ordering guarantee
 * applies across all concurrent sends from the same device session.
 */
export const lamportClock = new LamportClock();

// ============================================================================
// Ordering Utility
// ============================================================================

/**
 * Compare two messages by their Lamport-aware ordering key.
 *
 * Sort order: (created_at ASC, lamport_clock ASC, origin_id ASC)
 *
 * This matches the index defined in migration 028:
 *   `idx_messages_lamport_ordering ON session_messages(session_id, created_at, lamport_clock, id)`
 *
 * WHY origin_id (id) as final tiebreaker: Two messages from different origins
 * (phone vs. terminal) could theoretically have the same Lamport clock value
 * if both sent before seeing the other's message. Using the origin UUID as the
 * final tiebreaker gives us a deterministic total order without requiring a
 * coordinator.
 *
 * @param a - First message with created_at, lamport_clock, and id
 * @param b - Second message
 * @returns Negative if a < b, zero if equal, positive if a > b
 *
 * @example
 * const sorted = messages.sort(compareLamportOrder);
 */
export function compareLamportOrder(
  a: { createdAt: string; lamportClock: number; id: string },
  b: { createdAt: string; lamportClock: number; id: string }
): number {
  // Primary: wall-clock timestamp (ISO string lexicographic = chronological)
  const tsCompare = a.createdAt.localeCompare(b.createdAt);
  if (tsCompare !== 0) return tsCompare;

  // Secondary: Lamport logical clock (lower = happened-before)
  if (a.lamportClock !== b.lamportClock) {
    return a.lamportClock - b.lamportClock;
  }

  // Tertiary: origin ID (stable UUID comparison for determinism)
  return a.id.localeCompare(b.id);
}
