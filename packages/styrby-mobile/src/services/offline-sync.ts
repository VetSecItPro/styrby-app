/**
 * Offline Sync Service (Mobile)
 *
 * Watches for connectivity changes and syncs locally stored commands
 * to the Supabase `offline_command_queue` table when online.
 *
 * WHY: When the user is offline, commands are saved to local SQLite via
 * offline-storage.ts. This service is the bridge that pushes those local
 * records to the server-side table so they are visible across devices,
 * preserved in the audit trail, and processed by the backend.
 *
 * Uses @react-native-community/netinfo for reliable connectivity detection
 * on iOS and Android.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { supabase } from '../lib/supabase';
import {
  getPendingCommands,
  markSynced,
  clearSynced,
  type StoredCommand,
} from './offline-storage';

// ============================================================================
// Dev-Only Logger
// ============================================================================

/**
 * Development-only logger that suppresses output in production.
 * WHY: Prevents sync details from appearing in production logs.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[OfflineSync]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[OfflineSync]', ...args); },
  warn: (...args: unknown[]) => { if (__DEV__) console.warn('[OfflineSync]', ...args); },
};

// ============================================================================
// State
// ============================================================================

/** Whether a sync operation is currently in progress */
let isSyncing = false;

/** NetInfo unsubscribe function (set when listener is active) */
let unsubscribeNetInfo: (() => void) | null = null;

// ============================================================================
// Sync Logic
// ============================================================================

/**
 * Syncs all pending local commands to the Supabase `offline_command_queue` table.
 *
 * Each command is inserted individually so that partial failures do not
 * block the remaining commands. Successfully synced commands are marked
 * locally, and a cleanup pass removes them from SQLite.
 *
 * @returns The number of commands successfully synced
 *
 * @example
 * const synced = await syncPendingCommands();
 * console.log(`Synced ${synced} commands to Supabase`);
 */
export async function syncPendingCommands(): Promise<number> {
  if (isSyncing) {
    logger.log('Sync already in progress, skipping');
    return 0;
  }

  isSyncing = true;
  let syncedCount = 0;

  try {
    const pending = await getPendingCommands();

    if (pending.length === 0) {
      logger.log('No pending commands to sync');
      return 0;
    }

    logger.log(`Syncing ${pending.length} pending command(s)`);

    // Verify we have an authenticated user before attempting sync
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      logger.warn('No authenticated user, deferring sync');
      return 0;
    }

    for (const command of pending) {
      try {
        await syncSingleCommand(command, user.id);
        await markSynced(command.id);
        syncedCount++;
      } catch (error) {
        // WHY: We log and continue rather than throwing. A single failed
        // insert (e.g., duplicate key, schema mismatch) should not prevent
        // the rest of the queue from syncing.
        logger.error(`Failed to sync command ${command.id}:`, error);
      }
    }

    // Clean up synced records from local storage
    if (syncedCount > 0) {
      const cleaned = await clearSynced();
      logger.log(`Synced ${syncedCount} command(s), cleaned ${cleaned} local record(s)`);
    }
  } catch (error) {
    logger.error('Sync failed:', error);
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
 * @throws Error if the Supabase insert fails
 */
async function syncSingleCommand(command: StoredCommand, userId: string): Promise<void> {
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
 * Starts listening for network connectivity changes.
 * When the device transitions from offline to online, triggers a sync.
 *
 * WHY NetInfo over simple event listeners: React Native does not expose
 * `window.addEventListener('online')`. NetInfo provides cross-platform
 * connectivity detection that works on both iOS and Android, including
 * detection of cellular vs. wifi and actual internet reachability.
 *
 * @returns An unsubscribe function to stop listening
 *
 * @example
 * // In a useEffect:
 * useEffect(() => {
 *   const unsub = startConnectivityListener();
 *   return unsub;
 * }, []);
 */
export function startConnectivityListener(): () => void {
  // Prevent duplicate listeners
  if (unsubscribeNetInfo) {
    logger.warn('Connectivity listener already active');
    return unsubscribeNetInfo;
  }

  let wasConnected = true;

  unsubscribeNetInfo = NetInfo.addEventListener((state: NetInfoState) => {
    const isConnected = state.isConnected === true && state.isInternetReachable !== false;

    // Only sync on transition from offline to online
    if (isConnected && !wasConnected) {
      logger.log('Connection restored, triggering sync');
      syncPendingCommands();
    }

    wasConnected = isConnected;
  });

  // Run an initial sync in case there are pending commands from a previous session
  syncPendingCommands();

  return () => {
    if (unsubscribeNetInfo) {
      unsubscribeNetInfo();
      unsubscribeNetInfo = null;
    }
  };
}

/**
 * Stops the connectivity listener if active.
 * Safe to call even if no listener is running.
 */
export function stopConnectivityListener(): void {
  if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
    logger.log('Connectivity listener stopped');
  }
}
