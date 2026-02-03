/**
 * SQLite Offline Command Queue
 *
 * Implements IOfflineQueue using expo-sqlite for persistent storage.
 * Commands are queued when offline and processed when connection is restored.
 */

import * as SQLite from 'expo-sqlite';
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
      priority INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON command_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON command_queue(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_expires ON command_queue(expires_at);
  `);

  return db;
}

/**
 * Convert a database row to a QueuedCommand object.
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
 */
class SQLiteOfflineQueue implements IOfflineQueue {
  private initialized = false;

  /**
   * Ensure database is initialized before operations.
   */
  private async ensureInitialized(): Promise<SQLite.SQLiteDatabase> {
    if (!this.initialized) {
      await initDatabase();
      this.initialized = true;
    }
    return db!;
  }

  /**
   * Add a command to the queue.
   */
  async enqueue(message: RelayMessage, options?: EnqueueOptions): Promise<QueuedCommand> {
    const database = await this.ensureInitialized();
    const command = createQueuedCommand(message, options);

    await database.runAsync(
      `INSERT INTO command_queue (id, message, status, attempts, max_attempts, created_at, expires_at, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.id,
        JSON.stringify(command.message),
        command.status,
        command.attempts,
        command.maxAttempts,
        command.createdAt,
        command.expiresAt,
        command.priority,
      ]
    );

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
