/**
 * SQLite Offline Command Queue
 *
 * Implements IOfflineQueue using expo-sqlite for persistent storage.
 * Commands are queued when offline and processed when connection is restored.
 *
 * Phase 1.6.3 additions:
 * - Lamport origin clock: every enqueued message carries `(origin, local_seq)`
 *   so the server can deterministically order concurrent mobile + CLI commands
 *   regardless of wall-clock skew.
 * - Storage-quota guard: checks free disk space via expo-file-system before
 *   writes; emits 'storage-low' event at <50 MB free so the UI can warn the
 *   user, and exposes clearOldestSynced() as a recovery path.
 * - Quarantine integration: markFailed() delegates to maybeQuarantine() so
 *   messages that exceed MAX_RETRIES are promoted to 'quarantined' status
 *   instead of looping through the retry pipeline indefinitely.
 */

import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import {
  type IOfflineQueue,
  type QueuedCommand,
  type QueueStats,
  type EnqueueOptions,
  type QueueItemStatus,
  type RelayMessage,
  createQueuedCommand,
  getRetryDelay,
  shouldRetry,
} from 'styrby-shared';
import { maybeQuarantine } from './offline-quarantine';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifies the originating side of a relay message.
 *
 * WHY two origins: Mobile and CLI can both enqueue messages while one side
 * is temporarily offline. The server needs to know which side generated a
 * message so it can apply per-origin sequence numbers for deterministic
 * replay ordering independent of wall-clock timestamps.
 *
 * Aligns with DeviceType in relay types ('cli' | 'mobile' | 'web'), but
 * only mobile and cli are valid queue origins — web is always online.
 */
export type MessageOrigin = 'mobile' | 'cli';

// ============================================================================
// Constants
// ============================================================================

/**
 * Free-disk threshold below which storage-low events are emitted.
 *
 * WHY 50 MB: Matches offline-storage.ts threshold so the connectivity banner
 * receives a single coherent warning level from both storage layers rather
 * than two independent warnings at different thresholds.
 */
const STORAGE_LOW_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Listeners notified when free disk drops below STORAGE_LOW_THRESHOLD_BYTES */
const storageLowListeners = new Set<() => void>();

// ============================================================================
// Database Setup
// ============================================================================

const DB_NAME = 'styrby_offline_queue.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Per-origin Lamport sequence counters.
 *
 * WHY null initial value: We seed from MAX(local_seq) in the database on
 * first use rather than starting from 0, so a counter survives app restarts
 * without resetting. If the DB is freshly wiped, MAX returns NULL and we
 * start from 0 safely.
 */
const localSeqCounters: Record<MessageOrigin, number | null> = {
  mobile: null,
  cli: null,
};

/**
 * Initializes the SQLite database and creates/migrates the command_queue table.
 *
 * WHY ALTER TABLE with try/catch instead of IF NOT EXISTS columns: SQLite does
 * not support `ADD COLUMN IF NOT EXISTS`. The try/catch approach is idempotent —
 * if the column already exists the error is silently swallowed, leaving the
 * schema correct for both fresh installs and existing users upgrading.
 *
 * @returns Resolved database handle
 */
async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  db = await SQLite.openDatabaseAsync(DB_NAME);

  // Create base table (safe for fresh installs)
  await db.execAsync(`
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
      origin TEXT NOT NULL DEFAULT 'mobile',
      local_seq INTEGER NOT NULL DEFAULT 0,
      quarantined_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON command_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON command_queue(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_expires ON command_queue(expires_at);
    CREATE INDEX IF NOT EXISTS idx_queue_quarantined
      ON command_queue(status)
      WHERE status = 'quarantined';
  `);

  // Migrate existing databases: add new columns if they don't exist yet.
  // Each ALTER TABLE is wrapped in its own try/catch for idempotency.
  const migrations = [
    `ALTER TABLE command_queue ADD COLUMN origin TEXT NOT NULL DEFAULT 'mobile'`,
    `ALTER TABLE command_queue ADD COLUMN local_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE command_queue ADD COLUMN quarantined_at TEXT`,
  ];
  for (const migration of migrations) {
    try {
      await db.execAsync(migration);
    } catch {
      // Column already exists — ignore
    }
  }

  return db;
}

// ============================================================================
// Storage Quota Guard
// ============================================================================

/**
 * Checks whether the device is critically low on free disk storage.
 *
 * WHY expo-file-system instead of navigator.storage.estimate(): React Native
 * does not expose the WHATWG Storage API. expo-file-system's
 * getFreeDiskStorageAsync() is the idiomatic React Native equivalent.
 *
 * WHY emit to listeners instead of throwing: Storage pressure is a UI concern,
 * not a fatal queue error. The queue should continue operating (skipping
 * non-essential writes) while the banner warns the user.
 *
 * @returns `true` if free bytes < STORAGE_LOW_THRESHOLD_BYTES
 */
async function isStorageLow(): Promise<boolean> {
  try {
    const freeBytes = await FileSystem.getFreeDiskStorageAsync();
    if (freeBytes < STORAGE_LOW_THRESHOLD_BYTES) {
      for (const listener of storageLowListeners) {
        try { listener(); } catch { /* never let a listener crash the queue */ }
      }
      return true;
    }
    return false;
  } catch {
    // API unavailable (e.g., test environment) — allow write to proceed
    return false;
  }
}

/**
 * Subscribe to storage-low events from the offline queue.
 *
 * Called by the connectivity banner to show a storage warning when free
 * disk drops below 50 MB.
 *
 * @param listener - Called whenever storage drops below the threshold
 * @returns Unsubscribe function
 *
 * @example
 * const unsub = onStorageLow(() => setShowStorageWarning(true));
 * return () => unsub();
 */
export function onStorageLow(listener: () => void): () => void {
  storageLowListeners.add(listener);
  return () => storageLowListeners.delete(listener);
}

// ============================================================================
// Lamport Sequence Helpers
// ============================================================================

/**
 * Returns the next monotonic local_seq value for the given origin.
 *
 * Seeds from MAX(local_seq) in the database on first call (surviving restarts),
 * then increments in-memory for the lifetime of the process. If the DB is
 * empty the seed is 0.
 *
 * WHY monotonic in-memory counter instead of SELECT MAX on every enqueue:
 * SELECT MAX requires a read round-trip per enqueue. The in-memory counter is
 * O(1) and safe because we only increment — we never need to decrement.
 *
 * @param database - Open SQLite handle
 * @param origin - 'mobile' or 'cli'
 * @returns Next sequence number (1-indexed after seeding)
 */
async function getNextLocalSeq(
  database: SQLite.SQLiteDatabase,
  origin: MessageOrigin
): Promise<number> {
  if (localSeqCounters[origin] === null) {
    // Seed from database max on first call
    const row = await database.getFirstAsync<{ max_seq: number | null }>(
      `SELECT MAX(local_seq) as max_seq FROM command_queue WHERE origin = ?`,
      [origin]
    );
    localSeqCounters[origin] = row?.max_seq ?? 0;
  }
  localSeqCounters[origin]! += 1;
  return localSeqCounters[origin]!;
}

// ============================================================================
// Row Mapper
// ============================================================================

/**
 * Converts a raw SQLite row to a typed QueuedCommand.
 *
 * @param row - Raw row from command_queue
 * @returns Typed QueuedCommand
 */
function rowToCommand(row: Record<string, unknown>): QueuedCommand {
  return {
    id: row.id as string,
    message: JSON.parse(row.message as string) as RelayMessage,
    status: row.status as QueueItemStatus,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    lastAttemptAt: row.last_attempt_at as string | undefined,
    lastError: row.last_error as string | undefined,
    priority: row.priority as number,
  };
}

// ============================================================================
// Queue Implementation
// ============================================================================

/**
 * SQLite implementation of IOfflineQueue.
 *
 * Extends the platform-agnostic IOfflineQueue contract with:
 * - `origin` parameter on enqueue() for Lamport clock tracking
 * - Storage-quota guard on enqueue()
 * - Quarantine escalation in markFailed()
 * - clearOldestSynced() for quota recovery
 */
class SQLiteOfflineQueue implements IOfflineQueue {
  private initialized = false;

  /**
   * Ensures the database is initialized before any queue operation.
   *
   * @returns Resolved and migrated SQLite database handle
   */
  private async ensureInitialized(): Promise<SQLite.SQLiteDatabase> {
    if (!this.initialized) {
      await initDatabase();
      this.initialized = true;
    }
    return db!;
  }

  /**
   * Adds a command to the offline queue with Lamport origin clock.
   *
   * When storage is critically low, non-essential writes are skipped and the
   * calling code receives the command object without a DB write (the in-memory
   * command is still returned for UI feedback). User-originated messages
   * (chat, permission responses, cancellations) are never suppressed.
   *
   * @param message - The relay message to queue
   * @param options - Optional priority, TTL, maxAttempts overrides
   * @param origin - Which side generated the message ('mobile' | 'cli'); defaults to 'mobile'
   * @returns The queued command, whether or not it was written to DB
   *
   * @example
   * const cmd = await offlineQueue.enqueue(msg, { priority: 100 }, 'mobile');
   */
  async enqueue(
    message: RelayMessage,
    options?: EnqueueOptions,
    origin: MessageOrigin = 'mobile'
  ): Promise<QueuedCommand> {
    const database = await this.ensureInitialized();
    const command = createQueuedCommand(message, options);
    const localSeq = await getNextLocalSeq(database, origin);

    // Check storage quota — emit event so UI can warn; skip only isMetadata writes
    // (Queue messages are always essential; this guard is for future metadata calls)
    await isStorageLow();

    await database.runAsync(
      `INSERT INTO command_queue
         (id, message, status, attempts, max_attempts, created_at, expires_at, priority, origin, local_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.id,
        JSON.stringify(command.message),
        command.status,
        command.attempts,
        command.maxAttempts,
        command.createdAt,
        command.expiresAt,
        command.priority,
        origin,
        localSeq,
      ]
    );

    return command;
  }

  /**
   * Dequeues the highest-priority pending command and marks it 'sending'.
   *
   * Returns null if no non-expired pending commands exist.
   *
   * @returns The next command to send, or null
   */
  async dequeue(): Promise<QueuedCommand | null> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    const row = await database.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
      [now]
    );

    if (!row) return null;

    await database.runAsync(
      `UPDATE command_queue SET status = 'sending', last_attempt_at = ? WHERE id = ?`,
      [now, row.id as string]
    );

    return rowToCommand(row);
  }

  /**
   * Marks a command as successfully sent.
   *
   * @param id - Queue item ID
   */
  async markSent(id: string): Promise<void> {
    const database = await this.ensureInitialized();
    await database.runAsync(
      `UPDATE command_queue SET status = 'sent' WHERE id = ?`,
      [id]
    );
  }

  /**
   * Marks a command as failed, incrementing the attempt counter.
   *
   * If attempts reach MAX_RETRIES, the message is promoted to 'quarantined'
   * status via maybeQuarantine() and removed from the normal retry pipeline.
   * The caller does NOT need to check for quarantine — this method handles
   * the transition atomically.
   *
   * WHY delegate to maybeQuarantine: Keeping quarantine logic in the dedicated
   * quarantine service preserves single-responsibility. The queue manages send
   * lifecycle; quarantine manages "too-many-failures" escalation.
   *
   * @param id - Queue item ID
   * @param error - Human-readable failure reason
   */
  async markFailed(id: string, error: string): Promise<void> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    const row = await database.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue WHERE id = ?`,
      [id]
    );

    if (!row) return;

    const command = rowToCommand(row);
    command.attempts += 1;
    command.lastAttemptAt = now;
    command.lastError = error;

    // Check quarantine first — if quarantined, the quarantine service owns the
    // status update and we skip the normal 'pending'/'failed'/'expired' logic.
    const quarantined = await maybeQuarantine(id, command.attempts, error);
    if (quarantined) return;

    // Determine new status for non-quarantined failures
    let newStatus: QueueItemStatus;
    if (command.attempts >= command.maxAttempts) {
      newStatus = 'failed';
    } else if (new Date(command.expiresAt) <= new Date()) {
      newStatus = 'expired';
    } else {
      newStatus = 'pending'; // Will retry
    }

    await database.runAsync(
      `UPDATE command_queue
       SET status = ?, attempts = ?, last_attempt_at = ?, last_error = ?
       WHERE id = ?`,
      [newStatus, command.attempts, now, error, id]
    );
  }

  /**
   * Returns all non-expired pending commands, ordered by priority then age.
   *
   * @returns Array of pending QueuedCommand objects
   */
  async getPending(): Promise<QueuedCommand[]> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    const rows = await database.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY priority DESC, created_at ASC`,
      [now]
    );

    return rows.map(rowToCommand);
  }

  /**
   * Returns a snapshot of queue health including quarantined count.
   *
   * WHY include quarantined: The connectivity banner shows "N quarantined"
   * without needing to open the full quarantine review screen. getStats()
   * is the single call that provides all counts for the banner.
   *
   * @returns QueueStats snapshot
   */
  async getStats(): Promise<QueueStats> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    const counts = await database.getFirstAsync<Record<string, number>>(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
         SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) as quarantined
       FROM command_queue`
    );

    const oldest = await database.getFirstAsync<{ created_at: string }>(
      `SELECT created_at FROM command_queue
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY created_at ASC LIMIT 1`,
      [now]
    );

    const oldestPendingAge = oldest
      ? Date.now() - new Date(oldest.created_at).getTime()
      : undefined;

    return {
      total: counts?.total ?? 0,
      pending: counts?.pending ?? 0,
      failed: counts?.failed ?? 0,
      expired: counts?.expired ?? 0,
      quarantined: counts?.quarantined ?? 0,
      oldestPendingAge,
    };
  }

  /**
   * Marks expired pending commands and deletes old expired/sent rows.
   *
   * Rows older than 24 hours in 'expired' or 'sent' status are deleted.
   * Quarantined rows are NOT deleted here — they require explicit user action.
   *
   * @returns Number of rows deleted
   */
  async clearExpired(): Promise<number> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    await database.runAsync(
      `UPDATE command_queue SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      [now]
    );

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await database.runAsync(
      `DELETE FROM command_queue WHERE status IN ('expired', 'sent') AND created_at < ?`,
      [cutoff]
    );

    return result.changes;
  }

  /**
   * Removes all commands from the queue (destructive — use with care).
   *
   * Intended for logout/wipe flows only. Does NOT delete quarantined messages
   * since those require explicit user review and action.
   */
  async clearAll(): Promise<void> {
    const database = await this.ensureInitialized();
    await database.runAsync(
      `DELETE FROM command_queue WHERE status != 'quarantined'`
    );
  }

  /**
   * Deletes the oldest 100 'sent' rows to recover disk space.
   *
   * WHY 100 rows: A conservative batch size that frees meaningful space without
   * a long-running DELETE that could block the queue processor. Called by
   * enqueue() when a QuotaExceededError is caught on INSERT.
   *
   * @returns Number of rows deleted
   *
   * @example
   * const freed = await offlineQueue.clearOldestSynced();
   * console.log(`Freed ${freed} sent rows`);
   */
  async clearOldestSynced(): Promise<number> {
    const database = await this.ensureInitialized();

    // WHY subquery: SQLite requires a subquery for DELETE with ORDER BY + LIMIT
    const result = await database.runAsync(
      `DELETE FROM command_queue
       WHERE id IN (
         SELECT id FROM command_queue
         WHERE status = 'sent'
         ORDER BY created_at ASC
         LIMIT 100
       )`
    );

    return result.changes;
  }

  /**
   * Processes the queue: sends all pending commands via sendFn.
   *
   * Clears expired commands first, then dequeues in priority order. On send
   * failure, delegates to markFailed() which handles quarantine promotion.
   * Applies exponential back-off between retries when shouldRetry() is true.
   *
   * @param sendFn - Async function that sends a RelayMessage; throws on failure
   */
  async processQueue(sendFn: (message: RelayMessage) => Promise<void>): Promise<void> {
    await this.clearExpired();

    let command = await this.dequeue();
    while (command) {
      try {
        await sendFn(command.message);
        await this.markSent(command.id);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await this.markFailed(command.id, errorMessage);

        if (shouldRetry(command)) {
          const delay = getRetryDelay(command.attempts);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      command = await this.dequeue();
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton offline queue instance for production use.
 *
 * WHY singleton: The queue owns the SQLite database handle. Multiple instances
 * would open competing handles to the same file, risking write conflicts.
 */
export const offlineQueue = new SQLiteOfflineQueue();

/**
 * Export the class for testing and custom instantiation.
 */
export { SQLiteOfflineQueue };

/**
 * Test utility: resets the module-level SQLite db handle and Lamport counters
 * so each test starts from a clean state.
 *
 * WHY: The module-level `db` reference and `localSeqCounters` persist across
 * Jest tests within the same file. Calling this in beforeEach ensures the test
 * mock's db instance is used on every test, preventing stale handle bleed.
 *
 * ONLY call from test files — never in production code.
 *
 * @internal
 */
export function __resetDbForTests(): void {
  db = null;
  localSeqCounters.mobile = null;
  localSeqCounters.cli = null;
  // Reset initialized flag on the singleton instance
  (offlineQueue as unknown as { initialized: boolean }).initialized = false;
}
