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

import { createRelayClient, type RelayClient } from '@styrby/shared/relay';
import type { AgentType } from '@styrby/shared';
import { createClient } from '@/lib/supabase/client';
import { encryptForSession } from './encryption';
import {
  getPendingCommands,
  markSynced,
  clearSynced,
  type StoredCommand,
} from './offline-storage';

/** localStorage key holding the web device's machine id (shared with useRelaySend). */
const WEB_MACHINE_ID_KEY = 'styrby_web_machine_id';

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

    // Open a transient relay connection to DELIVER queued chats now that we're
    // back online. Best-effort: if the relay can't connect, commands are still
    // persisted to the audit queue below (delivery just doesn't happen this
    // pass). The CLI session may also have ended — then the broadcast reaches
    // no listener, which is acceptable (the command is still recorded).
    const relay = await openDeliveryRelay(supabase, user.id);

    try {
      for (const command of pending) {
        try {
          // 1. Persist to the server queue (audit + cross-device record).
          await syncSingleCommand(command, user.id, supabase);
          // 2. Deliver chats to the agent over the relay (best-effort).
          await deliverCommand(relay, command);
          await markSynced(command.id);
          syncedCount++;
        } catch (error) {
          // WHY: We log and continue rather than throwing. A single failed
          // upsert (e.g., schema mismatch) should not block the rest of the queue.
          console.error(`[OfflineSync] Failed to sync command ${command.id}:`, error);
        }
      }
    } finally {
      if (relay) await relay.disconnect().catch(() => { /* best-effort teardown */ });
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
 * Upserts a single command into the Supabase `offline_command_queue` table.
 *
 * Fixes the latent bugs the bug-hunt found (2026-06-09):
 *  - machine_id is the command's REAL target machine (was `userId` → FK
 *    violation against machines(id), so every sync failed).
 *  - session_id is carried through (was omitted).
 *  - queue_order = Date.parse(created_at) ms-epoch is now safe (migration 098
 *    widened the column INTEGER → BIGINT; INT4 overflowed before).
 *  - `upsert` on the `id` PK with ignoreDuplicates makes re-sync idempotent
 *    (a markSynced failure or a double online event won't error or duplicate).
 *
 * WHY command_encrypted holds the JSON payload with a placeholder nonce: this
 * row is the audit/cross-device record (RLS-protected, GDPR-exported); live
 * E2E delivery happens over the relay (see the delivery step in
 * syncPendingCommands). At-rest encryption of the queued command itself is a
 * tracked follow-up.
 *
 * @param command - The locally stored command to sync
 * @param userId - The authenticated user's ID for the user_id column
 * @param supabase - The Supabase client instance
 * @throws Error if the Supabase upsert fails
 */
async function syncSingleCommand(
  command: StoredCommand,
  userId: string,
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  // Encrypt the command payload at rest (NaCl box to the target machine, same
  // as session message E2E). The DB then holds ciphertext, not plaintext JSON —
  // offline_command_queue is owner-readable (RLS) + GDPR-exported. If the CLI's
  // public key isn't available yet we cannot encrypt: throw so this command
  // stays pending and retries on the next sync (no plaintext is ever written).
  const enc = await encryptForSession(command.payload, command.machine_id);
  if (!enc) {
    throw new Error(`No encryption key for machine ${command.machine_id}; deferring command ${command.id}`);
  }

  const { error } = await supabase
    .from('offline_command_queue')
    .upsert(
      {
        id: command.id,
        user_id: userId,
        machine_id: command.machine_id,
        session_id: command.session_id,
        command_encrypted: enc.content_encrypted,
        encryption_nonce: enc.encryption_nonce,
        queue_order: Date.parse(command.created_at),
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
 * Open a transient relay connection used to deliver queued commands on
 * reconnect. Returns null when the relay can't be created/connected — delivery
 * is best-effort, so the caller still persists commands to the audit queue.
 *
 * @param supabase - Authenticated Supabase client.
 * @param userId - The user's id (relay channel is `relay:{userId}`).
 * @returns A connected RelayClient, or null if connection failed.
 */
async function openDeliveryRelay(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<RelayClient | null> {
  try {
    const deviceId =
      (typeof localStorage !== 'undefined' && localStorage.getItem(WEB_MACHINE_ID_KEY)) ||
      `web_${crypto.randomUUID()}`;
    const relay = createRelayClient({
      supabase,
      userId,
      deviceId,
      deviceType: 'web',
      deviceName: 'Web Dashboard (offline-sync)',
      platform: 'web',
    });
    await relay.connect();
    return relay;
  } catch (error) {
    console.error(
      '[OfflineSync] Delivery relay unavailable; commands persisted but not delivered this pass:',
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
    console.error(`[OfflineSync] Failed to deliver command ${command.id} over relay:`, error);
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
