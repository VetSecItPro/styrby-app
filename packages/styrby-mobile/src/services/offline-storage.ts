/**
 * SQLite Offline Storage Adapter
 *
 * Provides a local persistence layer for commands that need to be synced
 * to the Supabase `offline_command_queue` table when connectivity returns.
 *
 * WHY: The offline-queue.ts file handles queueing relay messages for
 * immediate send when reconnected. This storage adapter handles a
 * different concern: persisting commands that must be written to the
 * server-side offline_command_queue table for audit, ordering, and
 * cross-device visibility. Think of offline-queue as "send when online"
 * and offline-storage as "persist to cloud when online."
 *
 * Uses expo-sqlite for persistent storage that survives app restarts.
 *
 * Storage quota hardening (Phase 1.6.3):
 * - saveCommand() checks free disk space via expo-file-system before writing.
 * - If < STORAGE_LOW_THRESHOLD_BYTES, emits 'storage-low' event and skips
 *   non-essential writes (metadata-only payloads).
 * - If the write fails with a quota/disk-full error, clearSynced() is called
 *   automatically and the write is retried once.
 */

import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';

// ============================================================================
// Types
// ============================================================================

/**
 * A command stored locally for eventual sync to Supabase.
 * Mirrors the columns in the `offline_command_queue` table.
 */
export interface StoredCommand {
  /** Unique command ID (UUID) */
  id: string;
  /** The type of command (e.g., 'chat', 'permission_response', 'cancel') */
  command_type: string;
  /** JSON-serialized command payload */
  payload: string;
  /** ISO 8601 timestamp when the command was created */
  created_at: string;
  /** Whether this command has been synced to Supabase */
  synced: boolean;
}

/**
 * Input for saving a new command (id and created_at are auto-generated
 * if not provided, synced defaults to false).
 */
export interface SaveCommandInput {
  /** Optional custom ID; generated via crypto.randomUUID() if omitted */
  id?: string;
  /** The type of command */
  command_type: string;
  /** The command payload (will be JSON-stringified) */
  payload: Record<string, unknown>;
  /** Optional custom timestamp; defaults to now */
  created_at?: string;
  /**
   * Whether this is a metadata-only (non-essential) write.
   *
   * WHY: When storage is critically low we skip non-essential writes to
   * preserve space for user-originated messages (chat, permission responses).
   * Metadata-only writes (e.g., UI state snapshots, analytics) are marked
   * `isMetadata: true` so they can be safely dropped under pressure.
   */
  isMetadata?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Free-disk threshold below which non-essential writes are suppressed.
 *
 * WHY 50 MB: Consistent with offline-queue.ts. Both layers share the same
 * threshold so the user receives a single coherent warning banner rather than
 * two independent warnings at different levels.
 */
const STORAGE_LOW_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Listeners notified when storage drops below threshold */
const storageLowListeners = new Set<() => void>();

// ============================================================================
// Database Setup
// ============================================================================

const DB_NAME = 'styrby_offline_storage.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Initializes the SQLite database and creates the storage table if needed.
 *
 * WHY separate from offline-queue DB: The offline queue manages relay
 * messages with retry logic. This table tracks commands bound for the
 * Supabase offline_command_queue table, which has different columns
 * (command_encrypted, encryption_nonce, queue_order, etc.).
 *
 * @returns The initialized SQLite database instance
 */
async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  db = await SQLite.openDatabaseAsync(DB_NAME);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_storage (
      id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_storage_synced
      ON offline_storage(synced)
      WHERE synced = 0;

    CREATE INDEX IF NOT EXISTS idx_storage_created
      ON offline_storage(created_at ASC);
  `);

  return db;
}

// ============================================================================
// Storage Quota Guard
// ============================================================================

/**
 * Checks whether the device is critically low on disk storage.
 *
 * Uses expo-file-system's getFreeDiskStorageAsync() as React Native does not
 * expose the WHATWG Storage API (navigator.storage.estimate()).
 *
 * WHY emit event instead of throw: Storage pressure is not a fatal error for
 * the calling code — it is a signal for the UI to warn the user. Throwing
 * would propagate through saveCommand() and abort message delivery unnecessarily.
 * The caller decides whether to skip non-essential writes based on the return value.
 *
 * @returns `true` if free bytes < STORAGE_LOW_THRESHOLD_BYTES, `false` otherwise
 */
async function checkStorageQuota(): Promise<boolean> {
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
 * Subscribe to storage-low events from the offline storage layer.
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
// Storage Adapter
// ============================================================================

/**
 * Saves a command to local SQLite storage for later sync to Supabase.
 *
 * Storage-quota behaviour:
 * - If storage is low AND `isMetadata` is true, the write is skipped and
 *   `null` is returned. This prevents analytics/metadata noise from consuming
 *   the last available bytes before a user message is queued.
 * - If storage is low AND `isMetadata` is false (default), the write proceeds.
 * - If the write throws a QuotaExceededError, clearSynced() is called to free
 *   space and the write is retried once.
 *
 * @param command - The command data to persist locally
 * @returns The full StoredCommand record that was written, or `null` if skipped
 *
 * @example
 * const result = await saveCommand({
 *   command_type: 'chat',
 *   payload: { content: 'Hello', agent: 'claude' },
 * });
 * if (!result) {
 *   console.warn('Storage critically low — non-essential write skipped');
 * }
 */
export async function saveCommand(command: SaveCommandInput): Promise<StoredCommand | null> {
  const database = await initDatabase();

  const isLow = await checkStorageQuota();

  // WHY skip non-essential writes when storage is low:
  // Metadata writes (UI state snapshots, analytics events) are safe to drop
  // under storage pressure. User-originated messages (command_type 'chat',
  // 'permission_response', 'cancel') are never marked isMetadata and always
  // proceed — losing those would damage user trust.
  if (isLow && command.isMetadata) {
    return null;
  }

  const stored: StoredCommand = {
    id: command.id ?? crypto.randomUUID(),
    command_type: command.command_type,
    payload: JSON.stringify(command.payload),
    created_at: command.created_at ?? new Date().toISOString(),
    synced: false,
  };

  const doInsert = async () => {
    await database.runAsync(
      `INSERT INTO offline_storage (id, command_type, payload, created_at, synced)
       VALUES (?, ?, ?, ?, ?)`,
      [stored.id, stored.command_type, stored.payload, stored.created_at, 0]
    );
  };

  try {
    await doInsert();
  } catch (err) {
    const isQuota =
      err instanceof Error &&
      (err.message.includes('QuotaExceededError') ||
        err.message.includes('disk full') ||
        err.message.includes('SQLITE_FULL'));

    if (isQuota) {
      // WHY clearSynced before retry: synced rows are server-confirmed and safe
      // to drop locally. This frees enough space for the current write without
      // discarding any un-synced user messages.
      await clearSynced();
      await doInsert(); // retry once — if it fails again, let it propagate
    } else {
      throw err;
    }
  }

  return stored;
}

/**
 * Retrieves all commands that have not yet been synced to Supabase.
 * Results are ordered by created_at ascending so the oldest commands
 * are synced first, preserving chronological order.
 *
 * @returns Array of pending (unsynced) commands
 *
 * @example
 * const pending = await getPendingCommands();
 * console.log(`${pending.length} commands awaiting sync`);
 */
export async function getPendingCommands(): Promise<StoredCommand[]> {
  const database = await initDatabase();

  const rows = await database.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM offline_storage
     WHERE synced = 0
     ORDER BY created_at ASC`
  );

  return rows.map(rowToStoredCommand);
}

/**
 * Marks a specific command as synced after successful upload to Supabase.
 *
 * @param id - The command ID to mark as synced
 *
 * @example
 * await markSynced('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
 */
export async function markSynced(id: string): Promise<void> {
  const database = await initDatabase();

  await database.runAsync(
    `UPDATE offline_storage SET synced = 1 WHERE id = ?`,
    [id]
  );
}

/**
 * Removes all synced commands from local storage.
 *
 * WHY: Once commands are confirmed in Supabase, the local copies are
 * unnecessary. Periodic cleanup prevents unbounded SQLite growth.
 * Also called as the quota-recovery path in saveCommand() when a
 * QuotaExceededError is caught.
 *
 * @returns The number of rows deleted
 *
 * @example
 * const removed = await clearSynced();
 * console.log(`Cleaned up ${removed} synced commands`);
 */
export async function clearSynced(): Promise<number> {
  const database = await initDatabase();

  const result = await database.runAsync(
    `DELETE FROM offline_storage WHERE synced = 1`
  );

  return result.changes;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Converts a raw database row into a typed StoredCommand object.
 *
 * @param row - Raw row from SQLite query
 * @returns Typed StoredCommand
 */
function rowToStoredCommand(row: Record<string, unknown>): StoredCommand {
  return {
    id: row.id as string,
    command_type: row.command_type as string,
    payload: row.payload as string,
    created_at: row.created_at as string,
    synced: (row.synced as number) === 1,
  };
}

/**
 * Test utility: resets the module-level SQLite db handle so each test
 * starts from a clean state.
 *
 * WHY: The module-level `db` reference persists across Jest tests within
 * the same file. Calling this in beforeEach ensures the test mock's db
 * instance is used on every test, preventing stale handle bleed.
 *
 * ONLY call from test files — never in production code.
 *
 * @internal
 */
export function __resetDbForTests(): void {
  db = null;
}
