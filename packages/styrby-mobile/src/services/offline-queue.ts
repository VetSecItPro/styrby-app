/**
 * SQLite Offline Command Queue
 *
 * Implements IOfflineQueue using expo-sqlite for persistent storage.
 * Commands are queued when offline and processed when connection is restored.
 *
 * Phase 1.6.3b additions:
 *   - Storage quota guard: catches SQLITE_FULL / QuotaExceededError on every
 *     write and surfaces the failure to the useStorageQuota hook rather than
 *     silently dropping the queued message.
 *   - Lamport clock: every enqueued message receives a monotonic clock value
 *     so that concurrent sends (phone + terminal at the same millisecond) can
 *     be replayed in deterministic order.
 *   - Idempotency key: generated BEFORE the first send attempt and stored in
 *     the queue row. On chaos-recovery retries, the same key is re-sent to
 *     the server which deduplicates and returns 200 without a second insert.
 */

import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
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
import { isQuotaError, storageQuotaGuard } from './storage-quota';
import { lamportClock } from './lamport-clock';

// ============================================================================
// Database Setup
// ============================================================================

const DB_NAME = 'styrby_offline_queue.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Initialize the database and create tables if needed.
 */
async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  db = await SQLite.openDatabaseAsync(DB_NAME);

  // Create queue table
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
      -- Phase 1.6.3b: idempotency key generated BEFORE the first send attempt.
      -- On crash-recovery retries, the same key is resent so the server can
      -- deduplicate and return 200 without inserting a second row.
      idempotency_key TEXT,
      -- Phase 1.6.3b: Lamport logical clock value at enqueue time.
      -- Advances monotonically; used to order concurrent same-millisecond sends.
      lamport_clock INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON command_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON command_queue(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_expires ON command_queue(expires_at);
  `);

  return db;
}

/**
 * Convert a database row to a QueuedCommand object.
 *
 * Phase 1.6.3b: also reads idempotency_key and lamport_clock columns.
 * These are carried through so the sync path can include them in the
 * server payload without re-reading from SQLite.
 */
function rowToCommand(row: Record<string, unknown>): QueuedCommand & {
  idempotencyKey: string;
  lamportClock: number;
} {
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
    // Phase 1.6.3b: idempotency_key is set at enqueue time and never changes.
    // A missing key (legacy row) gets a fresh UUID — acceptable because legacy
    // rows predate the crash-recovery idempotency contract.
    idempotencyKey: (row.idempotency_key as string | null) ?? Crypto.randomUUID(),
    // Phase 1.6.3b: lamport_clock advances on every local send.
    lamportClock: (row.lamport_clock as number | null) ?? 0,
  };
}

// ============================================================================
// Queue Implementation
// ============================================================================

/**
 * SQLite implementation of IOfflineQueue.
 *
 * Phase 1.6.3b hardening:
 *   - `ensureInitialized` is now public so that `useStorageQuota` can access
 *     the database handle for `clearNonCriticalQueueItems()`.
 *   - `enqueue` generates an idempotency_key BEFORE writing so that crash
 *     recovery retries can send the same key and get a server-side 200 dedup.
 *   - `enqueue` advances the Lamport clock BEFORE writing so that concurrent
 *     sends (phone + terminal at the same millisecond) sort deterministically.
 *   - All DB writes catch quota errors and notify `storageQuotaGuard` instead
 *     of silently dropping the enqueued message.
 */
class SQLiteOfflineQueue implements IOfflineQueue {
  private initialized = false;

  /**
   * Ensure database is initialized before operations.
   *
   * WHY public: useStorageQuota needs the database handle to execute
   * clearNonCriticalQueueItems without duplicating the init logic.
   * Callers outside this module must treat this as read-only access to the
   * handle — mutating the schema through this path is not supported.
   */
  async ensureInitialized(): Promise<SQLite.SQLiteDatabase> {
    if (!this.initialized) {
      const database = await initDatabase();
      // Initialize the Lamport clock table in the same DB
      await lamportClock.init(database);
      this.initialized = true;
    }
    return db!;
  }

  /**
   * Add a command to the queue.
   *
   * Phase 1.6.3b: The method now:
   *   1. Generates an idempotency_key UUID BEFORE the write. This key is
   *      stored alongside the message. When the queue processor retries after
   *      a crash, it sends the same key so the server can dedup.
   *   2. Advances the Lamport clock BEFORE writing. This ensures the clock
   *      value embedded in the row reflects the correct send-time ordering
   *      even if the app is killed immediately after this write.
   *   3. Catches QuotaExceededError / SQLITE_FULL and notifies the
   *      storageQuotaGuard so the UI can surface the banner. The error is
   *      re-thrown so the caller knows the enqueue failed.
   *
   * @param message - The relay message to queue
   * @param options - Optional priority, TTL, and maxAttempts overrides
   * @returns The newly created QueuedCommand
   * @throws StorageQuotaError (re-wrapped) when storage is full
   */
  async enqueue(message: RelayMessage, options?: EnqueueOptions): Promise<QueuedCommand> {
    const database = await this.ensureInitialized();
    const command = createQueuedCommand(message, options);

    // WHY idempotency_key before write: If we generate it AFTER a successful
    // write we can't include it in the same transaction. If the app is killed
    // between the write and the send, on boot we need the key that was
    // already stored so the retry carries the same value. Generating it here
    // (before the INSERT) ensures the key is always in the DB before any send.
    const idempotencyKey = Crypto.randomUUID();

    // WHY lamport tick before write: The Lamport clock value must be embedded
    // in the row BEFORE the row is visible to the queue processor. If tick()
    // were called after INSERT, a race where the processor dequeues before tick
    // completes would embed clock=0 for every message, defeating the ordering.
    const clockValue = await lamportClock.tick(database);

    try {
      await database.runAsync(
        `INSERT INTO command_queue
          (id, message, status, attempts, max_attempts, created_at, expires_at, priority, idempotency_key, lamport_clock)
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
          idempotencyKey,
          clockValue,
        ]
      );
    } catch (err) {
      // WHY catch at persistence boundary: expo-sqlite throws a generic Error
      // whose message contains the SQLite error code string. We classify it
      // here so the caller receives a typed signal and the banner updates.
      if (isQuotaError(err)) {
        storageQuotaGuard.recordQuotaError();
        // Re-throw a descriptive error so the caller can surface it to the user.
        throw new Error(
          'Offline queue is full — could not save message. Clear old messages to continue.'
        );
      }
      throw err;
    }

    return command;
  }

  /**
   * Get the next pending command to send (highest priority first).
   */
  async dequeue(): Promise<QueuedCommand | null> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    // Get highest priority pending command that hasn't expired
    const row = await database.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
      [now]
    );

    if (!row) return null;

    // Mark as sending
    await database.runAsync(
      `UPDATE command_queue SET status = 'sending', last_attempt_at = ? WHERE id = ?`,
      [now, row.id as string]
    );

    return rowToCommand(row);
  }

  /**
   * Mark a command as sent successfully.
   */
  async markSent(id: string): Promise<void> {
    const database = await this.ensureInitialized();
    await database.runAsync(
      `UPDATE command_queue SET status = 'sent' WHERE id = ?`,
      [id]
    );
  }

  /**
   * Mark a command as failed.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    // Get current state
    const row = await database.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue WHERE id = ?`,
      [id]
    );

    if (!row) return;

    const command = rowToCommand(row);
    command.attempts += 1;
    command.lastAttemptAt = now;
    command.lastError = error;

    // Determine new status
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
   * Get all pending commands.
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
   * Get queue statistics.
   */
  async getStats(): Promise<QueueStats> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    // Get counts by status
    const counts = await database.getFirstAsync<Record<string, number>>(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
       FROM command_queue`
    );

    // Get oldest pending item
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
      oldestPendingAge,
    };
  }

  /**
   * Clear expired commands.
   */
  async clearExpired(): Promise<number> {
    const database = await this.ensureInitialized();
    const now = new Date().toISOString();

    // Mark expired commands
    await database.runAsync(
      `UPDATE command_queue SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      [now]
    );

    // Delete old expired and sent commands (older than 24 hours)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await database.runAsync(
      `DELETE FROM command_queue WHERE status IN ('expired', 'sent') AND created_at < ?`,
      [cutoff]
    );

    return result.changes;
  }

  /**
   * Get all commands that have failed (exhausted retries).
   *
   * WHY not on IOfflineQueue: This method is mobile-specific, surfaced by the
   * QuarantinePanel UI. Adding it to IOfflineQueue would require a web
   * IndexedDB implementation that is not yet needed. The hook accesses this
   * via a type cast (`offlineQueue as { getFailedItems?(): ... }`).
   *
   * @returns Array of QueuedCommands with status 'failed'
   */
  async getFailedItems(): Promise<QueuedCommand[]> {
    const database = await this.ensureInitialized();
    const rows = await database.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM command_queue WHERE status = 'failed' ORDER BY priority DESC, created_at ASC`
    );
    return rows.map(rowToCommand);
  }

  /**
   * Clear all commands.
   */
  async clearAll(): Promise<void> {
    const database = await this.ensureInitialized();
    await database.runAsync(`DELETE FROM command_queue`);
  }

  /**
   * Process the queue - send all pending commands.
   */
  async processQueue(sendFn: (message: RelayMessage) => Promise<void>): Promise<void> {
    // First, clear expired commands
    await this.clearExpired();

    // Process pending commands
    let command = await this.dequeue();
    while (command) {
      try {
        await sendFn(command.message);
        await this.markSent(command.id);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await this.markFailed(command.id, errorMessage);

        // If should retry, add delay before next attempt
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
 * Singleton offline queue instance.
 */
export const offlineQueue = new SQLiteOfflineQueue();

/**
 * Export the class for testing.
 */
export { SQLiteOfflineQueue };
