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
 */

import * as SQLite from 'expo-sqlite';

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
}

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
// Storage Adapter
// ============================================================================

/**
 * Saves a command to local SQLite storage for later sync to Supabase.
 *
 * @param command - The command data to persist locally
 * @returns The full StoredCommand record that was written
 *
 * @example
 * await saveCommand({
 *   command_type: 'chat',
 *   payload: { content: 'Hello', agent: 'claude' },
 * });
 */
export async function saveCommand(command: SaveCommandInput): Promise<StoredCommand> {
  const database = await initDatabase();

  const stored: StoredCommand = {
    id: command.id ?? crypto.randomUUID(),
    command_type: command.command_type,
    payload: JSON.stringify(command.payload),
    created_at: command.created_at ?? new Date().toISOString(),
    synced: false,
  };

  await database.runAsync(
    `INSERT INTO offline_storage (id, command_type, payload, created_at, synced)
     VALUES (?, ?, ?, ?, ?)`,
    [stored.id, stored.command_type, stored.payload, stored.created_at, 0]
  );

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
