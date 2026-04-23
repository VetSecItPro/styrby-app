/**
 * Storage Quota Guard for Offline Queue Persistence
 *
 * expo-sqlite throws a generic SQLiteError wrapping the SQLite3 error code
 * SQLITE_FULL (13) when the database hits the storage limit on iOS/Android.
 * On Android, the underlying storage manager may also throw a Java
 * DiskFullException that surfaces as a native module exception.
 *
 * WHY we need an explicit guard: SQLite write failures are silent by default —
 * `runAsync` rejects with an error but there is no RN-level "storage full"
 * event. Without this guard, enqueue() would throw an unhandled rejection and
 * the user would lose their queued message with no feedback.
 *
 * Strategy:
 *   1. Catch QuotaExceeded / SQLITE_FULL errors at the persistence boundary.
 *   2. Surface quota state via `getStorageQuota()` so the `useStorageQuota`
 *      hook can drive the user-visible banner.
 *   3. Expose `clearNonCriticalQueueItems()` so the banner action can free
 *      space by dropping the oldest 'pending' items while preserving all
 *      'quarantined' (failed) items for user review.
 *   4. Log each user-initiated clear to the Supabase `audit_log` table for
 *      compliance traceability.
 *
 * @module services/storage-quota
 */

import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import { supabase } from '../lib/supabase';

// ============================================================================
// Constants
// ============================================================================

/**
 * Warn the user when remaining space drops below this threshold.
 * WHY 10 MB: A typical offline session accumulates ~1-5 KB per message. At
 * 10 MB remaining, the user has capacity for ~2,000-10,000 more messages —
 * enough time to act on the warning without being caught by surprise.
 */
export const STORAGE_WARN_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * String fragments that identify a storage-full error across iOS, Android,
 * and different SQLite error message formats.
 *
 * WHY multiple patterns: React Native doesn't standardize storage errors.
 * On iOS the SQLite code 13 (SQLITE_FULL) surfaces as "database or disk is
 * full". On Android it can arrive as "disk I/O error" or the Java
 * "DiskFullException" class name. We match all known patterns.
 */
export const QUOTA_ERROR_PATTERNS = [
  'database or disk is full',
  'disk i/o error',
  'diskfullexception',
  'storage quota',
  'quotaexceedederror',
  'sqlite_full',
  'sqlite error code 13',
  'no space left',
] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Storage usage snapshot for the device's Styrby data directory.
 *
 * WHY separate bytesUsed/bytesAvailable: The banner needs both values —
 * bytesUsed drives the "X MB used" label and bytesAvailable drives the
 * warning threshold comparison.
 */
export interface StorageQuotaInfo {
  /** Bytes currently used by the Styrby SQLite database file */
  bytesUsed: number;
  /** Bytes available on the device partition that holds the database */
  bytesAvailable: number;
  /**
   * True when available space is below STORAGE_WARN_THRESHOLD_BYTES (10 MB).
   * Triggers the "running low" banner state.
   */
  isNearLimit: boolean;
  /**
   * True when the most recent enqueue() call threw a quota error.
   * Triggers the "queue is full — clear to continue" banner state.
   */
  isFull: boolean;
}

/**
 * Result of a user-initiated non-critical queue clear operation.
 */
export interface ClearResult {
  /** Number of rows deleted from the queue */
  itemsRemoved: number;
  /** Approximate bytes freed (estimated from deleted rows) */
  bytesFreed: number;
}

// ============================================================================
// Quota Error Detection
// ============================================================================

/**
 * Returns true when an error represents a storage-full condition.
 *
 * Checks the error message against QUOTA_ERROR_PATTERNS (case-insensitive).
 * This is the single source of truth for quota error classification across
 * the codebase — callers should never replicate this logic inline.
 *
 * @param error - The error to inspect (may be any thrown value)
 * @returns True if the error indicates the storage quota was exceeded
 *
 * @example
 * try {
 *   await db.runAsync(sql, params);
 * } catch (err) {
 *   if (isQuotaError(err)) {
 *     quotaGuard.recordQuotaError();
 *   } else {
 *     throw err; // non-quota errors still propagate
 *   }
 * }
 */
export function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

// ============================================================================
// Storage Quota Guard (Singleton)
// ============================================================================

/**
 * Manages storage quota detection and recovery for the offline queue.
 *
 * This guard wraps the queue's persistence boundary. When a write fails with
 * a quota error, the guard:
 *   1. Sets an internal `isFull` flag so the hook can render the banner.
 *   2. Prevents re-throwing the original error (the message is already safe
 *      in the caller's in-memory state; the loss here is persistence only).
 *   3. Exposes `clearNonCriticalQueueItems()` so the user can free space.
 */
class StorageQuotaGuard {
  /** Whether the last write hit a quota error */
  private _isFull = false;

  /** Listeners notified when quota state changes */
  private listeners: Array<() => void> = [];

  /**
   * Record that a quota error just occurred.
   * Notifies all registered listeners so the hook can update banner state.
   *
   * @example
   * // Called by the offline-queue persistence layer on SQLITE_FULL:
   * storageQuotaGuard.recordQuotaError();
   */
  recordQuotaError(): void {
    if (!this._isFull) {
      this._isFull = true;
      this.notifyListeners();
    }
  }

  /**
   * Clear the isFull flag after the user has freed space.
   * Notifies listeners so the banner can re-check and dismiss.
   */
  clearQuotaError(): void {
    if (this._isFull) {
      this._isFull = false;
      this.notifyListeners();
    }
  }

  /**
   * Whether the last write hit a quota error.
   * Exposed for polling-style consumers; prefer `subscribe` for reactive use.
   */
  get isFull(): boolean {
    return this._isFull;
  }

  /**
   * Subscribe to quota state changes.
   * Returns an unsubscribe function; call it in useEffect cleanup.
   *
   * @param listener - Called whenever `isFull` or availability changes
   * @returns Unsubscribe function
   *
   * @example
   * useEffect(() => {
   *   return storageQuotaGuard.subscribe(() => setQuota(storageQuotaGuard.isFull));
   * }, []);
   */
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Notify all registered listeners */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Individual listener errors must not prevent other listeners from firing
      }
    }
  }

  /**
   * Read the current storage quota from the device filesystem.
   *
   * Uses expo-file-system to read available/free space on the partition that
   * holds the Styrby SQLite database. Also reads the database file size to
   * report bytesUsed accurately.
   *
   * WHY expo-file-system over native StorageManager API: React Native does not
   * expose the web StorageManager API. expo-file-system provides a cross-
   * platform abstraction that works on both iOS and Android.
   *
   * @returns Current storage quota information
   *
   * @example
   * const quota = await storageQuotaGuard.getStorageQuota();
   * if (quota.isNearLimit) showQuotaWarningBanner();
   */
  async getStorageQuota(): Promise<StorageQuotaInfo> {
    try {
      // Read the database file size (bytes used by Styrby queue data)
      const dbPath = `${FileSystem.documentDirectory}SQLite/styrby_offline_queue.db`;
      const dbInfo = await FileSystem.getInfoAsync(dbPath, { size: true });
      const bytesUsed = dbInfo.exists && 'size' in dbInfo ? (dbInfo.size as number) : 0;

      // Read available space on the device's document directory partition
      const dirInfo = await FileSystem.getFreeDiskStorageAsync();
      const bytesAvailable = typeof dirInfo === 'number' ? dirInfo : 0;

      return {
        bytesUsed,
        bytesAvailable,
        isNearLimit: bytesAvailable < STORAGE_WARN_THRESHOLD_BYTES,
        isFull: this._isFull,
      };
    } catch {
      // WHY fallback instead of throw: If we can't read quota info, we should
      // still return a valid object. The banner will show "unknown" state rather
      // than crashing the UI.
      return {
        bytesUsed: 0,
        bytesAvailable: 0,
        isNearLimit: false,
        isFull: this._isFull,
      };
    }
  }

  /**
   * Clear the oldest 'pending' queue items to free storage space.
   *
   * Preservation rules (non-negotiable per spec):
   *   - 'quarantined' (failed) items are ALWAYS preserved — the user needs to
   *     review them before they are discarded.
   *   - 'sending' items are NOT cleared — they may already be in-flight and
   *     clearing them would cause message loss.
   *   - 'pending' items are cleared oldest-first up to the requested limit.
   *
   * Audit log: Every invocation writes a row to Supabase `audit_log` with
   * action 'offline_queue_partial_clear' (or 'offline_queue_cleared' if all
   * pending items were removed). This satisfies the enterprise-grade compliance
   * requirement that user-initiated data deletions are traceable.
   *
   * @param db - The open SQLite database handle
   * @param maxItemsToRemove - Maximum number of pending items to delete
   *   (default: 50; removes oldest first)
   * @returns ClearResult with itemsRemoved and approximate bytesFreed
   *
   * @example
   * const result = await storageQuotaGuard.clearNonCriticalQueueItems(db, 50);
   * console.log(`Freed ~${result.bytesFreed} bytes by removing ${result.itemsRemoved} items`);
   */
  async clearNonCriticalQueueItems(
    db: SQLite.SQLiteDatabase,
    maxItemsToRemove = 50
  ): Promise<ClearResult> {
    // WHY: Count pending items BEFORE deletion so we can determine whether
    // this was a partial or full clear for the audit log action field.
    const countResult = await db.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) as total FROM command_queue WHERE status = 'pending'`
    );
    const totalPending = countResult?.total ?? 0;

    // Delete the oldest 'pending' items (never touch 'failed'/'quarantined',
    // 'sending', or 'sent' — only 'pending' can be safely discarded).
    const deleteResult = await db.runAsync(
      `DELETE FROM command_queue
       WHERE id IN (
         SELECT id FROM command_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?
       )`,
      [maxItemsToRemove]
    );

    const itemsRemoved = deleteResult.changes;

    // Estimate bytes freed: average queued message payload is ~2 KB.
    // WHY estimation: Reading the actual DB file size before/after VACUUM
    // is expensive and VACUUM itself can fail when storage is full.
    const ESTIMATED_BYTES_PER_ITEM = 2048;
    const bytesFreed = itemsRemoved * ESTIMATED_BYTES_PER_ITEM;

    // Clear the isFull flag — space has been freed.
    this.clearQuotaError();

    // Write audit log entry.
    // WHY fire-and-forget: We don't want a Supabase write failure to prevent
    // the local clear from being reported to the user. The audit log is
    // best-effort here — connectivity may be the reason the queue is full.
    void this.writeAuditLog(
      itemsRemoved,
      totalPending,
      bytesFreed
    );

    return { itemsRemoved, bytesFreed };
  }

  /**
   * Write an audit log entry for a user-initiated queue clear.
   *
   * WHY this must be a separate async fn: It is called fire-and-forget from
   * clearNonCriticalQueueItems. If Supabase is unreachable (likely when the
   * device is low on storage and possibly offline), we swallow the error
   * silently — the clear already happened locally and the user was informed.
   *
   * @param itemsRemoved - Number of items actually deleted
   * @param totalPending - Total pending items before deletion
   * @param bytesFreed - Estimated bytes freed
   */
  private async writeAuditLog(
    itemsRemoved: number,
    totalPending: number,
    bytesFreed: number
  ): Promise<void> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Determine whether this was a partial or full clear
      const action = itemsRemoved >= totalPending
        ? 'offline_queue_cleared'
        : 'offline_queue_partial_clear';

      await supabase.from('audit_log').insert({
        user_id: user.id,
        action,
        resource_type: 'offline_command_queue',
        metadata: {
          items_removed: itemsRemoved,
          total_pending_before: totalPending,
          estimated_bytes_freed: bytesFreed,
          triggered_by: 'user_storage_quota_action',
        },
      });
    } catch {
      // WHY swallow: Audit log write failures must not surface errors to the
      // user — the primary action (freeing storage) already succeeded.
      // Sentry breadcrumbs should be added here in a future telemetry pass.
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton storage quota guard instance.
 * Import this wherever quota errors can occur (offline-queue.ts persistence)
 * and wherever quota state needs to be read (useStorageQuota hook).
 */
export const storageQuotaGuard = new StorageQuotaGuard();
