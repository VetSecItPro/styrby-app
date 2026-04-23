/**
 * StorageQuotaBanner — Offline Queue Full / Near-Full Warning UI
 *
 * Renders a dismissible banner when the offline queue's SQLite storage is
 * full or running low. Provides a "Clear non-critical queue items" action
 * that removes the oldest 'pending' items while preserving 'failed'
 * (quarantined) messages for user review.
 *
 * WHY a banner vs. a modal: The storage issue is recoverable and non-blocking.
 * A banner allows the user to continue reading their session while deciding
 * whether to clear. A modal would interrupt their flow unnecessarily.
 *
 * Renders nothing when quota is healthy. The orchestrator can unconditionally
 * include `<StorageQuotaBanner />` — it self-hides.
 *
 * Accessibility:
 *   - Banner container has `accessibilityRole="alert"` for immediate
 *     VoiceOver/TalkBack announcement when it appears.
 *   - The "Clear" button has an explicit `accessibilityHint` explaining the
 *     destructive nature of the action.
 *   - `accessibilityLiveRegion="assertive"` on the status text so the clearing
 *     confirmation is announced without user focus change.
 *
 * @module components/offline-queue/StorageQuotaBanner
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useStorageQuota } from '../../hooks/useStorageQuota';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for StorageQuotaBanner.
 * All props are optional — the component reads quota state from the hook.
 */
export interface StorageQuotaBannerProps {
  /**
   * Maximum number of pending items to clear on each "Clear" tap.
   * Defaults to 50.
   */
  maxItemsPerClear?: number;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Displays a storage quota warning banner when the offline queue is full or
 * near-full, and exposes a one-tap clear action.
 *
 * @param props.maxItemsPerClear - Maximum items to clear per user action
 *
 * @example
 * // Drop this anywhere in the screen tree; it self-hides when healthy:
 * <StorageQuotaBanner />
 */
export function StorageQuotaBanner({
  maxItemsPerClear = 50,
}: StorageQuotaBannerProps): React.ReactElement | null {
  const {
    quota,
    shouldShowBanner,
    bannerMessage,
    clearNonCriticalItems,
    isClearing,
    clearError,
  } = useStorageQuota();

  // Local state: show a brief "X items cleared" confirmation after success
  const [lastClearResult, setLastClearResult] = useState<{
    itemsRemoved: number;
    bytesFreed: number;
  } | null>(null);

  const handleClear = useCallback(async () => {
    setLastClearResult(null);
    try {
      const result = await clearNonCriticalItems(maxItemsPerClear);
      setLastClearResult(result);
      // Auto-dismiss confirmation after 4 seconds
      setTimeout(() => setLastClearResult(null), 4_000);
    } catch {
      // clearError is set by the hook; no additional handling needed here
    }
  }, [clearNonCriticalItems, maxItemsPerClear]);

  // Self-hide when quota is healthy and no recent clear result to show
  if (!shouldShowBanner && !lastClearResult) return null;

  const isFull = quota?.isFull ?? false;

  return (
    <View
      accessibilityRole="alert"
      className={[
        'mx-4 my-2 rounded-xl px-4 py-3',
        isFull
          ? 'bg-red-50 border border-red-200'
          : 'bg-amber-50 border border-amber-200',
      ].join(' ')}
    >
      {/* Banner message */}
      {bannerMessage && (
        <Text
          className={[
            'text-sm font-medium mb-2',
            isFull ? 'text-red-800' : 'text-amber-800',
          ].join(' ')}
          accessibilityLiveRegion="assertive"
        >
          {bannerMessage}
        </Text>
      )}

      {/* Storage usage detail */}
      {quota && (
        <Text
          className={[
            'text-xs mb-3',
            isFull ? 'text-red-600' : 'text-amber-600',
          ].join(' ')}
        >
          {quota.bytesUsed > 0
            ? `Queue using ${formatBytes(quota.bytesUsed)} · ${formatBytes(quota.bytesAvailable)} available`
            : `${formatBytes(quota.bytesAvailable)} available on device`}
        </Text>
      )}

      {/* Post-clear confirmation */}
      {lastClearResult && !isClearing && (
        <Text
          className="text-xs text-green-700 mb-2"
          accessibilityLiveRegion="assertive"
        >
          Cleared {lastClearResult.itemsRemoved} item
          {lastClearResult.itemsRemoved === 1 ? '' : 's'}, freed ~
          {formatBytes(lastClearResult.bytesFreed)}. Quarantined messages were
          preserved.
        </Text>
      )}

      {/* Error state */}
      {clearError && !isClearing && (
        <Text
          className="text-xs text-red-700 mb-2"
          accessibilityRole="alert"
        >
          Clear failed: {clearError}
        </Text>
      )}

      {/* Action button */}
      <Pressable
        onPress={handleClear}
        disabled={isClearing}
        accessibilityRole="button"
        accessibilityLabel="Clear non-critical queue items"
        accessibilityHint="Removes the oldest pending messages from the offline queue. Quarantined messages that need your review will be kept."
        className={[
          'flex-row items-center justify-center rounded-lg py-2 px-4 self-start',
          isFull ? 'bg-red-100 active:bg-red-200' : 'bg-amber-100 active:bg-amber-200',
          isClearing ? 'opacity-60' : '',
        ].join(' ')}
      >
        {isClearing ? (
          <ActivityIndicator
            size="small"
            color={isFull ? '#DC2626' : '#D97706'}
          />
        ) : (
          <Text
            className={[
              'text-sm font-semibold',
              isFull ? 'text-red-700' : 'text-amber-700',
            ].join(' ')}
          >
            Clear non-critical queue items
          </Text>
        )}
      </Pressable>
    </View>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a byte count to a human-readable string.
 *
 * WHY local helper vs. shared utility: The formatting rules here are specific
 * to this banner (always show one decimal place for MB, round KB to integers).
 * A generic utility with configurable precision is overkill for this context.
 *
 * @param bytes - Byte count to format
 * @returns Human-readable string e.g. "2.4 MB" or "512 KB"
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
