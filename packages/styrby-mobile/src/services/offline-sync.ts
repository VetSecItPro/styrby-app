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
import * as SecureStore from 'expo-secure-store';
import { createRelayClient, type RelayClient, type AgentType } from 'styrby-shared';
import { supabase } from '../lib/supabase';
import { encryptMessage } from './encryption';
import {
  getPendingCommands,
  markSynced,
  clearSynced,
  type StoredCommand,
} from './offline-storage';

/**
 * SecureStore key holding this device's stable relay identifier.
 * WHY duplicated here (not imported from useRelay): `useRelay` does not export
 * its STORAGE_KEYS map or getOrCreateDeviceId helper, and importing the hook
 * module from a non-React service would pull React Native UI deps into the
 * sync service. We read the same key directly so the offline-sync relay reuses
 * the device id the live relay already persisted (no duplicate presence entry).
 */
const DEVICE_ID_KEY = 'styrby_device_id';

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

    // Open a transient relay connection to DELIVER queued chats now that we're
    // back online. Best-effort: if the relay can't connect, commands are still
    // persisted to the audit queue below (delivery just doesn't happen this
    // pass). The CLI session may also have ended — then the broadcast reaches
    // no listener, which is acceptable (the command is still recorded).
    const relay = await openDeliveryRelay(user.id);

    try {
      for (const command of pending) {
        try {
          // 1. Persist to the server queue (audit + cross-device record).
          await syncSingleCommand(command, user.id);
          // 2. Deliver chats to the agent over the relay (best-effort).
          await deliverCommand(relay, command);
          await markSynced(command.id);
          syncedCount++;
        } catch (error) {
          // WHY: We log and continue rather than throwing. A single failed
          // upsert (e.g., schema mismatch) should not prevent the rest of the
          // queue from syncing.
          logger.error(`Failed to sync command ${command.id}:`, error);
        }
      }
    } finally {
      if (relay) await relay.disconnect().catch(() => { /* best-effort teardown */ });
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
 * Upserts a single command into the Supabase `offline_command_queue` table.
 *
 * Mirrors the web fix (2026-06-09 bug-hunt + 2026-06-10 delivery loop):
 *  - machine_id is the command's REAL target machine (was `userId` → FK
 *    violation against machines(id), so every sync failed).
 *  - session_id is carried through (was omitted).
 *  - queue_order = Date.parse(created_at) ms-epoch is now safe (migration 098
 *    widened the column INTEGER → BIGINT; INT4 overflowed before).
 *  - `upsert` on the `id` PK with ignoreDuplicates makes re-sync idempotent
 *    (a markSynced failure or a double online event won't error or duplicate).
 *
 * Encrypts the command payload at rest (NaCl box to the target machine, same as
 * session message E2E) so the DB holds ciphertext, not plaintext JSON — the row
 * is owner-readable (RLS) + GDPR-exported. If the CLI's public key isn't
 * available, encryptMessage throws and the per-command catch in
 * syncPendingCommands leaves this command pending to retry next sync (no
 * plaintext is ever written). Live delivery is separate (see deliverCommand).
 *
 * @param command - The locally stored command to sync
 * @param userId - The authenticated user's ID for the user_id column
 * @throws Error if encryption fails (CLI key unavailable) or the upsert fails
 */
async function syncSingleCommand(command: StoredCommand, userId: string): Promise<void> {
  const enc = await encryptMessage(command.payload, command.machine_id);

  const { error } = await supabase
    .from('offline_command_queue')
    .upsert(
      {
        id: command.id,
        user_id: userId,
        machine_id: command.machine_id, // REAL machine, was userId = FK violation
        session_id: command.session_id,
        command_encrypted: enc.encrypted,
        encryption_nonce: enc.nonce,
        queue_order: Date.parse(command.created_at), // BIGINT-safe via migration 098
        status: 'pending',
        created_at: command.created_at,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }
}

/**
 * Reads the device's stable relay identifier from SecureStore, falling back to
 * a per-pass random id when none is persisted yet.
 *
 * @returns The device id (the live relay's `mobile_<uuid>` value when present).
 */
async function getDeviceId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY).catch(() => null);
  return stored ?? `mobile_${crypto.randomUUID()}`;
}

/**
 * Open a transient relay connection used to deliver queued commands on
 * reconnect. Returns null when the relay can't be created/connected — delivery
 * is best-effort, so the caller still persists commands to the audit queue.
 *
 * @param userId - The user's id (relay channel is `relay:{userId}`).
 * @returns A connected RelayClient, or null if connection failed.
 */
async function openDeliveryRelay(userId: string): Promise<RelayClient | null> {
  try {
    const deviceId = await getDeviceId();
    const relay = createRelayClient({
      supabase,
      userId,
      deviceId,
      deviceType: 'mobile',
      deviceName: 'Mobile App (offline-sync)',
      platform: 'mobile',
    });
    await relay.connect();
    return relay;
  } catch (error) {
    logger.error(
      'Delivery relay unavailable; commands persisted but not delivered this pass:',
      error
    );
    return null;
  }
}

/**
 * Deliver a queued command to the agent over the relay (chat commands only).
 *
 * No-op when the relay is unavailable or the command isn't a deliverable chat.
 * Never throws — delivery is best-effort and must not fail the sync (the command
 * is already persisted to the audit queue by the caller).
 *
 * @param relay - The delivery relay (or null when unavailable).
 * @param command - The queued command to deliver.
 */
async function deliverCommand(relay: RelayClient | null, command: StoredCommand): Promise<void> {
  if (!relay || command.command_type !== 'chat') return;
  try {
    const payload = JSON.parse(command.payload) as { content?: string; agent?: string };
    if (payload.content) {
      await relay.sendChat(
        payload.content,
        (payload.agent as AgentType) ?? 'claude',
        command.session_id ?? undefined
      );
    }
  } catch (error) {
    logger.error(`Failed to deliver command ${command.id} over relay:`, error);
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
