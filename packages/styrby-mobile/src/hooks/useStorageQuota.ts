/**
 * useStorageQuota — Reactive hook for offline queue storage quota state
 *
 * Exposes the current storage quota snapshot (bytesUsed, bytesAvailable,
 * isNearLimit, isFull) and a `clearNonCriticalItems` action that the quota
 * banner can invoke.
 *
 * WHY a hook instead of reading storageQuotaGuard directly in the component:
 * Per CLAUDE.md Component-First Architecture, side-effectful I/O (file system
 * reads, Supabase writes) belongs in hooks, not components. The component
 * receives stable state + stable callbacks and stays pure.
 *
 * WHY polling + subscription: The isFull flag is set by the enqueue path
 * (which runs outside of React's call stack). We subscribe to the guard's
 * listener so we get an immediate re-render on quota error. We also poll
 * every 30 seconds so isNearLimit stays fresh even without a write failure.
 *
 * @module hooks/useStorageQuota
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  storageQuotaGuard,
  type StorageQuotaInfo,
  type ClearResult,
} from '../services/storage-quota';
import { offlineQueue } from '../services/offline-queue';

// ============================================================================
// Constants
// ============================================================================

/**
 * How often to re-read disk usage in the background.
 * WHY 30s: Frequent enough to catch gradual quota exhaustion while the user
 * is actively sending messages, but infrequent enough to avoid hammering the
 * filesystem.
 */
const QUOTA_POLL_INTERVAL_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Return shape of the useStorageQuota hook.
 */
export interface UseStorageQuotaReturn {
  /** Current storage quota snapshot. Null until first read completes. */
  quota: StorageQuotaInfo | null;
  /** Whether the initial quota read is in progress */
  isLoading: boolean;
  /**
   * Whether the quota banner should be shown.
   * True when quota.isFull OR quota.isNearLimit.
   */
  shouldShowBanner: boolean;
  /**
   * Human-readable banner message to display.
   * Returns an appropriate string for the current quota state.
   */
  bannerMessage: string | null;
  /**
   * Clear the oldest pending queue items to free storage space.
   * Preserves quarantined (failed) items so the user can review them.
   *
   * @param maxItems - Maximum number of pending items to remove (default: 50)
   * @returns ClearResult with counts and estimated bytes freed
   */
  clearNonCriticalItems: (maxItems?: number) => Promise<ClearResult>;
  /** Whether a clear operation is currently in progress */
  isClearing: boolean;
  /** Error message if the clear operation failed, null otherwise */
  clearError: string | null;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manages storage quota monitoring and the non-critical queue clear action.
 *
 * Usage:
 * ```tsx
 * const { shouldShowBanner, bannerMessage, clearNonCriticalItems } = useStorageQuota();
 * if (!shouldShowBanner) return null;
 * return <StorageQuotaBanner message={bannerMessage} onClear={clearNonCriticalItems} />;
 * ```
 *
 * @returns UseStorageQuotaReturn — quota state + clear action
 */
export function useStorageQuota(): UseStorageQuotaReturn {
  const [quota, setQuota] = useState<StorageQuotaInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  // Ref to the poll interval so we can clear it on unmount
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ============================================================================
  // Quota Read
  // ============================================================================

  /**
   * Read the current quota and update state.
   * Safe to call multiple times (idempotent read).
   */
  const refreshQuota = useCallback(async () => {
    try {
      const info = await storageQuotaGuard.getStorageQuota();
      setQuota(info);
    } catch {
      // WHY swallow: If we can't read quota, we don't know the state.
      // Better to show no banner than to crash the screen.
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ============================================================================
  // Effects
  // ============================================================================

  useEffect(() => {
    // Initial read
    void refreshQuota();

    // Subscribe to instant updates when the guard detects a quota error
    // (fired synchronously from the offline-queue enqueue path)
    const unsubscribe = storageQuotaGuard.subscribe(() => {
      void refreshQuota();
    });

    // Background poll to keep isNearLimit fresh as the queue grows
    pollRef.current = setInterval(() => {
      void refreshQuota();
    }, QUOTA_POLL_INTERVAL_MS);

    return () => {
      unsubscribe();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [refreshQuota]);

  // ============================================================================
  // Clear Action
  // ============================================================================

  /**
   * Clear the oldest pending queue items to free storage.
   *
   * Delegates to storageQuotaGuard.clearNonCriticalQueueItems which:
   *   - Deletes oldest 'pending' items first
   *   - Preserves all 'failed' (quarantined) items
   *   - Writes an audit_log entry
   *
   * @param maxItems - Upper bound on items to remove (default: 50)
   */
  const clearNonCriticalItems = useCallback(async (maxItems = 50): Promise<ClearResult> => {
    setIsClearing(true);
    setClearError(null);

    try {
      // Access the SQLite database handle via the queue's ensureInitialized method.
      // WHY: storageQuotaGuard.clearNonCriticalQueueItems() needs the DB handle
      // to execute the DELETE and COUNT queries. ensureInitialized() was made
      // public in Phase 1.6.3b specifically for this use case.
      // WHY we use the cast: IOfflineQueue does not expose ensureInitialized()
      // (it is an implementation detail of SQLiteOfflineQueue). The cast is safe
      // because the mobile runtime always uses SQLiteOfflineQueue.
      const db = await (offlineQueue as unknown as {
        ensureInitialized(): Promise<import('expo-sqlite').SQLiteDatabase>;
      }).ensureInitialized();

      const result = await storageQuotaGuard.clearNonCriticalQueueItems(db, maxItems);

      // Refresh quota after the clear
      await refreshQuota();

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear queue items';
      setClearError(msg);
      throw err;
    } finally {
      setIsClearing(false);
    }
  }, [refreshQuota]);

  // ============================================================================
  // Derived State
  // ============================================================================

  const shouldShowBanner = Boolean(quota?.isFull || quota?.isNearLimit);

  let bannerMessage: string | null = null;
  if (quota?.isFull) {
    bannerMessage =
      'Offline queue is full - clear old messages to continue sending';
  } else if (quota?.isNearLimit) {
    bannerMessage =
      'Offline storage is running low - consider clearing old messages';
  }

  return {
    quota,
    isLoading,
    shouldShowBanner,
    bannerMessage,
    clearNonCriticalItems,
    isClearing,
    clearError,
  };
}
