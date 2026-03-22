/**
 * Offline Sync Service (Web)
 *
 * Watches for connectivity changes and syncs locally stored commands
 * to the Supabase `offline_command_queue` table when online.
 *
 * WHY: When the user is offline, commands are saved to local IndexedDB via
 * offline-storage.ts. This service is the bridge that pushes those local
 * records to the server-side table so they are visible across devices,
 * preserved in the audit trail, and processed by the backend.
 *
 * Uses the standard browser `online`/`offline` events for connectivity
 * detection, which is lightweight and well-supported across all modern
 * browsers.
 */

import { createClient } from '@/lib/supabase/client';
import {
  getPendingCommands,
  markSynced,
  clearSynced,
  type StoredCommand,
} from './offline-storage';

// ============================================================================
// State
// ============================================================================

/** Whether a sync operation is currently in progress */
let isSyncing = false;

/** Whether the connectivity listener has been registered */
let listenerActive = false;

/** Bound handler reference for cleanup */
let boundOnlineHandler: (() => void) | null = null;

// ============================================================================
// Sync Logic
// ============================================================================

/**
 * Syncs all pending local commands to the Supabase `offline_command_queue` table.
 *
 * Each command is inserted individually so that partial failures do not
 * block the remaining commands. Successfully synced commands are marked
 * locally, and a cleanup pass removes them from IndexedDB.
 *
 * @returns The number of commands successfully synced
 *
 * @example
 * const synced = await syncPendingCommands();
 * console.log(`Synced ${synced} commands to Supabase`);
 */
export async function syncPendingCommands(): Promise<number> {
  if (isSyncing) return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;

  isSyncing = true;
  let syncedCount = 0;

  try {
    const pending = await getPendingCommands();

    if (pending.length === 0) return 0;

    const supabase = createClient();

    // Verify we have an authenticated user before attempting sync
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      // No authenticated user; defer sync until next online event
      return 0;
    }

    for (const command of pending) {
      try {
        await syncSingleCommand(command, user.id, supabase);
        await markSynced(command.id);
        syncedCount++;
      } catch (error) {
        // WHY: We log and continue rather than throwing. A single failed
        // insert (e.g., duplicate key, schema mismatch) should not prevent
        // the rest of the queue from syncing.
        console.error(`[OfflineSync] Failed to sync command ${command.id}:`, error);
      }
    }

    // Clean up synced records from local storage
    if (syncedCount > 0) {
      await clearSynced();
    }
  } catch (error) {
    console.error('[OfflineSync] Sync failed:', error);
  } finally {
    isSyncing = false;
  }

  return syncedCount;
}

/**
 * Inserts a single command into the Supabase `offline_command_queue` table.
 *
 * WHY the command is inserted with minimal encryption fields: The Supabase
 * schema requires `command_encrypted` and `encryption_nonce`. In a full
 * implementation these would use the machine key's TweetNaCl encryption.
 * For now we store the JSON payload as the "encrypted" value with a
 * placeholder nonce, since end-to-end encryption is handled at the relay
 * layer and these commands are already authenticated via RLS.
 *
 * @param command - The locally stored command to sync
 * @param userId - The authenticated user's ID for the user_id column
 * @param supabase - The Supabase client instance
 * @throws Error if the Supabase insert fails
 */
async function syncSingleCommand(
  command: StoredCommand,
  userId: string,
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  const { error } = await supabase
    .from('offline_command_queue')
    .insert({
      user_id: userId,
      // WHY machine_id uses a placeholder: The actual machine_id should come
      // from the paired CLI instance. In a future iteration, the pairing
      // service will provide this. For now we use the user_id as a fallback
      // to satisfy the NOT NULL constraint.
      machine_id: userId,
      command_encrypted: command.payload,
      encryption_nonce: 'pending',
      queue_order: Date.parse(command.created_at),
      status: 'pending',
      created_at: command.created_at,
    });

  if (error) {
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
}

// ============================================================================
// Connectivity Listener
// ============================================================================

/**
 * Starts listening for browser online/offline events.
 * When the browser transitions from offline to online, triggers a sync.
 *
 * Safe to call multiple times; only one listener will be registered.
 *
 * @returns An unsubscribe function to stop listening
 *
 * @example
 * // In a React component or layout:
 * useEffect(() => {
 *   const unsub = startConnectivityListener();
 *   return unsub;
 * }, []);
 */
export function startConnectivityListener(): () => void {
  if (typeof window === 'undefined') {
    // SSR environment; no-op
    return () => {};
  }

  if (listenerActive && boundOnlineHandler) {
    return () => stopConnectivityListener();
  }

  boundOnlineHandler = () => {
    syncPendingCommands();
  };

  window.addEventListener('online', boundOnlineHandler);
  listenerActive = true;

  // Run an initial sync in case there are pending commands from a previous session
  if (navigator.onLine) {
    syncPendingCommands();
  }

  return () => stopConnectivityListener();
}

/**
 * Stops the connectivity listener if active.
 * Safe to call even if no listener is running.
 */
export function stopConnectivityListener(): void {
  if (typeof window === 'undefined') return;

  if (boundOnlineHandler) {
    window.removeEventListener('online', boundOnlineHandler);
    boundOnlineHandler = null;
  }
  listenerActive = false;
}
