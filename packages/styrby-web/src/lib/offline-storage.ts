/**
 * IndexedDB Offline Storage Adapter
 *
 * Provides a local persistence layer for commands that need to be synced
 * to the Supabase `offline_command_queue` table when connectivity returns.
 *
 * WHY: The offlineQueue.ts file handles queueing web dashboard actions
 * (budget alerts, bookmarks, etc.) for local execution via fetch when
 * online. This storage adapter handles a different concern: persisting
 * commands that must be written to the server-side offline_command_queue
 * table for audit, ordering, and cross-device visibility.
 *
 * Uses the `idb` package for a promise-based IndexedDB API with full
 * type safety via DBSchema.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

// ============================================================================
// Types
// ============================================================================

/**
 * A command stored locally for eventual sync to Supabase.
 * Mirrors the columns in the `offline_command_queue` table.
 */
export interface StoredCommand {
  /** Auto-incrementing local key (used as IndexedDB primary key) */
  localId?: number;
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
 * Input for saving a new command (localId is auto-generated,
 * id and created_at have defaults, synced defaults to false).
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
// IndexedDB Schema
// ============================================================================

/**
 * Type-safe IndexedDB schema for the offline storage database.
 */
interface OfflineStorageDB extends DBSchema {
  commands: {
    key: number;
    value: StoredCommand;
    indexes: {
      'by-synced': number;
      'by-created': string;
      'by-id': string;
    };
  };
}

// ============================================================================
// Constants
// ============================================================================

const DB_NAME = 'styrby-offline';
const DB_VERSION = 1;
const STORE_NAME = 'commands';

// ============================================================================
// Database Initialization
// ============================================================================

/** Cached database instance */
let dbInstance: IDBPDatabase<OfflineStorageDB> | null = null;

/** Promise for in-flight initialization (prevents concurrent opens) */
let initPromise: Promise<IDBPDatabase<OfflineStorageDB>> | null = null;

/**
 * Opens (or returns the cached) IndexedDB database.
 *
 * WHY init guard: IndexedDB open is async. Without the initPromise guard,
 * concurrent calls to getDb() would open multiple connections. The guard
 * ensures only one open operation runs and all callers share the result.
 *
 * @returns The initialized IndexedDB database instance
 */
async function getDb(): Promise<IDBPDatabase<OfflineStorageDB>> {
  if (dbInstance) return dbInstance;

  if (initPromise) return initPromise;

  initPromise = openDB<OfflineStorageDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE_NAME, {
        keyPath: 'localId',
        autoIncrement: true,
      });
      // Index for querying unsynced commands (synced = 0)
      store.createIndex('by-synced', 'synced');
      // Index for ordering by creation time
      store.createIndex('by-created', 'created_at');
      // Index for looking up by UUID
      store.createIndex('by-id', 'id', { unique: true });
    },
  });

  try {
    dbInstance = await initPromise;
    return dbInstance;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

// ============================================================================
// Storage Adapter
// ============================================================================

/**
 * Saves a command to local IndexedDB storage for later sync to Supabase.
 *
 * @param command - The command data to persist locally
 * @returns The full StoredCommand record that was written (including localId)
 *
 * @example
 * await saveCommand({
 *   command_type: 'chat',
 *   payload: { content: 'Hello', agent: 'claude' },
 * });
 */
export async function saveCommand(command: SaveCommandInput): Promise<StoredCommand> {
  const db = await getDb();

  const stored: StoredCommand = {
    id: command.id ?? crypto.randomUUID(),
    command_type: command.command_type,
    payload: JSON.stringify(command.payload),
    created_at: command.created_at ?? new Date().toISOString(),
    synced: false,
  };

  const localId = await db.add(STORE_NAME, stored);
  stored.localId = localId;

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
  const db = await getDb();

  // Get all commands where synced is false (stored as 0 in the index)
  const allCommands = await db.getAll(STORE_NAME);

  return allCommands
    .filter((cmd) => !cmd.synced)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Marks a specific command as synced after successful upload to Supabase.
 *
 * @param id - The command UUID to mark as synced
 *
 * @example
 * await markSynced('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
 */
export async function markSynced(id: string): Promise<void> {
  const db = await getDb();

  // Look up by UUID index
  const localId = await db.getKeyFromIndex(STORE_NAME, 'by-id', id);
  if (localId === undefined) return;

  const record = await db.get(STORE_NAME, localId);
  if (!record) return;

  record.synced = true;
  await db.put(STORE_NAME, record);
}

/**
 * Removes all synced commands from local storage.
 *
 * WHY: Once commands are confirmed in Supabase, the local copies are
 * unnecessary. Periodic cleanup prevents unbounded IndexedDB growth.
 *
 * @returns The number of records deleted
 *
 * @example
 * const removed = await clearSynced();
 * console.log(`Cleaned up ${removed} synced commands`);
 */
export async function clearSynced(): Promise<number> {
  const db = await getDb();

  const allCommands = await db.getAll(STORE_NAME);
  const syncedCommands = allCommands.filter((cmd) => cmd.synced);

  const tx = db.transaction(STORE_NAME, 'readwrite');
  for (const cmd of syncedCommands) {
    if (cmd.localId !== undefined) {
      tx.store.delete(cmd.localId);
    }
  }
  await tx.done;

  return syncedCommands.length;
}
