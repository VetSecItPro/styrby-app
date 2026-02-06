'use client';

import { useState, useEffect } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';

/**
 * Hook that tracks the browser's online/offline status.
 *
 * WHY: Users need visual feedback when they go offline, and actions should
 * be queued rather than failing silently. This hook provides real-time
 * connectivity status that components can use to show offline indicators
 * and adjust behavior accordingly.
 *
 * @returns Boolean indicating whether the browser is currently online
 *
 * @example
 * function MyComponent() {
 *   const isOnline = useOnlineStatus();
 *
 *   return (
 *     <button disabled={!isOnline}>
 *       {isOnline ? 'Save' : 'Offline - will sync later'}
 *     </button>
 *   );
 * }
 */
export function useOnlineStatus(): boolean {
  // Initialize with current online status, defaulting to true for SSR
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    /**
     * Handles the browser going online.
     * Also triggers offline queue processing.
     */
    const handleOnline = () => {
      setIsOnline(true);
      // Process any queued commands when coming back online
      offlineQueue.processQueue();
    };

    /**
     * Handles the browser going offline.
     */
    const handleOffline = () => {
      setIsOnline(false);
    };

    // Add event listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Cleanup on unmount
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

/**
 * Extended hook that provides both online status and queue length.
 *
 * WHY: Some UI elements want to show not just offline status but also
 * how many operations are pending sync. This provides both pieces of info.
 *
 * @returns Object with isOnline boolean and pendingCount number
 *
 * @example
 * function OfflineBadge() {
 *   const { isOnline, pendingCount } = useOnlineStatusWithQueue();
 *
 *   if (isOnline && pendingCount === 0) return null;
 *
 *   return (
 *     <div>
 *       {!isOnline && 'Offline'}
 *       {pendingCount > 0 && ` - ${pendingCount} pending`}
 *     </div>
 *   );
 * }
 */
export function useOnlineStatusWithQueue(): { isOnline: boolean; pendingCount: number } {
  const isOnline = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);

  // Fetch pending count on mount and when online status changes
  useEffect(() => {
    let isMounted = true;

    /**
     * Fetches the current queue length from IndexedDB.
     */
    const fetchPendingCount = async () => {
      try {
        const count = await offlineQueue.getQueueLength();
        if (isMounted) {
          setPendingCount(count);
        }
      } catch {
        // IndexedDB might not be available (e.g., private browsing)
        if (isMounted) {
          setPendingCount(0);
        }
      }
    };

    // Initial fetch with small delay to avoid setState during render
    const initialTimeout = setTimeout(fetchPendingCount, 0);

    // Refresh when coming back online (queue might have been processed)
    let onlineRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
    if (isOnline) {
      // Delay to allow queue processing to complete
      onlineRefreshTimeout = setTimeout(fetchPendingCount, 1000);
    }

    // Refresh periodically while offline to catch new queued items
    let offlineInterval: ReturnType<typeof setInterval> | undefined;
    if (!isOnline) {
      offlineInterval = setInterval(fetchPendingCount, 5000);
    }

    return () => {
      isMounted = false;
      clearTimeout(initialTimeout);
      if (onlineRefreshTimeout) clearTimeout(onlineRefreshTimeout);
      if (offlineInterval) clearInterval(offlineInterval);
    };
  }, [isOnline]);

  return { isOnline, pendingCount };
}
