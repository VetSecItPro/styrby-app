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
import { encryptAtRest, decryptAtRest } from './at-rest';

// ============================================================================
// Types
// ============================================================================

/**
 * A command stored locally for eventual sync to Supabase.
 * Mirrors the columns in the `offline_command_queue` table.
 */
export interface StoredCommand {
  /** Unique command ID (UUID) — also used as the server queue PK for dedup */
  id: string;
  /** The type of command (e.g., 'chat', 'permission_response', 'cancel') */
  command_type: string;
  /** JSON-serialized command payload */
  payload: string;
  /**
   * The CLI machine this command targets. REQUIRED: `offline_command_queue`
   * has `machine_id UUID NOT NULL REFERENCES machines(id)`, so this must be a
   * real machine id (NOT the user id — that was the FK-violation bug).
   */
  machine_id: string;
  /** The session this command belongs to, or null for session-less commands. */
  session_id: string | null;
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
  /** Target CLI machine id (required — FK to machines on the server queue). */
  machine_id: string;
  /** Owning session id, or null. */
  session_id?: string | null;
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

  // Fresh installs get machine_id + session_id from the CREATE TABLE below.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_storage (
      id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      machine_id TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_storage_synced
      ON offline_storage(synced)
      WHERE synced = 0;

    CREATE INDEX IF NOT EXISTS idx_storage_created
      ON offline_storage(created_at ASC);
  `);

  // WHY idempotent ALTER: tables created before the offline-sync parity work
  // (web PR-B mirror) lack the machine_id/session_id columns. SQLite's
  // `ALTER TABLE ... ADD COLUMN` is not `IF NOT EXISTS`-aware and THROWS
  // ("duplicate column name") if the column already exists, so we inspect the
  // current schema via PRAGMA table_info and only add the missing columns.
  // CREATE TABLE IF NOT EXISTS alone does not migrate an existing table.
  await migrateAddColumns(db);

  return db;
}

/**
 * Adds the `machine_id` / `session_id` columns to a pre-existing
 * `offline_storage` table that was created before the offline-sync parity
 * migration. Idempotent: inspects the live schema first and skips columns that
 * already exist (fresh installs already have both via CREATE TABLE).
 *
 * @param database - The open SQLite database to migrate.
 */
async function migrateAddColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await database.getAllAsync<{ name: string }>(
    `PRAGMA table_info(offline_storage)`
  );
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('machine_id')) {
    await database.execAsync(`ALTER TABLE offline_storage ADD COLUMN machine_id TEXT`);
  }
  if (!existing.has('session_id')) {
    await database.execAsync(`ALTER TABLE offline_storage ADD COLUMN session_id TEXT`);
  }
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
 *   machine_id: pairingInfo.machineId,
 *   session_id: sessionId,
 * });
 */
export async function saveCommand(command: SaveCommandInput): Promise<StoredCommand> {
  const database = await initDatabase();

  const stored: StoredCommand = {
    id: command.id ?? crypto.randomUUID(),
    command_type: command.command_type,
    payload: JSON.stringify(command.payload),
    machine_id: command.machine_id,
    session_id: command.session_id ?? null,
    created_at: command.created_at ?? new Date().toISOString(),
    synced: false,
  };

  // SEC-MOB-001: encrypt the payload at rest. The DB column holds ciphertext;
  // the returned StoredCommand keeps the plaintext payload for the caller.
  const encryptedPayload = await encryptAtRest(stored.payload);

  await database.runAsync(
    `INSERT INTO offline_storage (id, command_type, payload, machine_id, session_id, created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      stored.id,
      stored.command_type,
      encryptedPayload,
      stored.machine_id,
      stored.session_id,
      stored.created_at,
      0,
    ]
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

  // SEC-MOB-001: decrypt each payload back to plaintext for the sync consumer.
  // decryptAtRest passes legacy (pre-encryption) plaintext rows through
  // unchanged, so existing queues keep working without a migration.
  return Promise.all(
    rows.map(async (row) => {
      const cmd = rowToStoredCommand(row);
      cmd.payload = await decryptAtRest(cmd.payload);
      return cmd;
    }),
  );
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

/**
 * Delete EVERY queued command from local SQLite — synced or not.
 *
 * WHY (SEC-MOB-002): queued command payloads are user data that must not
 * survive ACCOUNT DELETION. Unlike clearSynced (housekeeping for already-synced
 * rows), this wipes pending rows too, so it must ONLY be called on account
 * deletion — never on a temporary sign-out, where pending commands should be
 * preserved to send after re-login.
 *
 * @returns The number of rows deleted.
 */
export async function clearAllCommands(): Promise<number> {
  const database = await initDatabase();
  const result = await database.runAsync(`DELETE FROM offline_storage`);
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
    machine_id: row.machine_id as string,
    session_id: (row.session_id as string | null) ?? null,
    created_at: row.created_at as string,
    synced: (row.synced as number) === 1,
  };
}
