/**
 * useInAppNotifications Hook
 *
 * Fetches, paginates, and subscribes to real-time in-app notifications
 * from the `notifications` Supabase table for the current user.
 *
 * WHY this hook exists: The mobile notification feed needs to:
 *  1. Load paginated history (20 per page)
 *  2. Subscribe to real-time inserts via Supabase Realtime
 *  3. Provide optimistic markAsRead / markAllAsRead with rollback on failure
 *  4. Filter out internal sentinel rows (budget_threshold with sentinel title)
 *
 * @returns Notification feed state and control functions
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * A single notification row from the `notifications` table.
 */
export interface InAppNotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Return type for the useInAppNotifications hook.
 */
export interface UseInAppNotificationsReturn {
  /** Loaded notifications, most recent first */
  notifications: InAppNotification[];
  /** Number of unread notifications */
  unreadCount: number;
  /** True while initial fetch is in progress */
  loading: boolean;
  /** True while a subsequent page is loading */
  loadingMore: boolean;
  /** Whether more pages exist */
  hasMore: boolean;
  /** Non-null if an error occurred during fetch */
  error: string | null;
  /** Mark a single notification as read */
  markAsRead: (id: string) => Promise<void>;
  /** Mark all unread notifications as read */
  markAllAsRead: () => Promise<void>;
  /** Load the next page of notifications */
  loadMore: () => Promise<void>;
  /** Re-fetch from the beginning */
  refresh: () => Promise<void>;
}

/**
 * Number of notifications to load per page.
 * WHY 20: Fits visible screen height on most devices without excessive DB round trips.
 */
const PAGE_SIZE = 20;

/**
 * Supabase Realtime channel name for the notification feed.
 * Includes user ID at subscribe time to isolate channels.
 */
const CHANNEL_PREFIX = 'in-app-notifications';

/**
 * Types that are internal sentinel rows and should never appear in the feed.
 * WHY: budget_threshold cron inserts a sentinel row to trigger the check;
 * it has title='__threshold_check__' and should be invisible to users.
 */
function isSentinelRow(notification: InAppNotification): boolean {
  return (
    notification.type === 'budget_threshold' &&
    notification.title === '__threshold_check__'
  );
}

/**
 * Hook that provides the in-app notification feed with real-time updates.
 *
 * @returns Feed state and control functions
 *
 * @example
 * const { notifications, unreadCount, markAsRead, loadMore } = useInAppNotifications();
 */
export function useInAppNotifications(): UseInAppNotificationsReturn {
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const channelRef = useRef<RealtimeChannel | null>(null);

  /**
   * Fetch a page of notifications starting at the given offset.
   *
   * @param pageOffset - Number of rows to skip
   * @param replace - If true, replace the current list (used for refresh)
   */
  const fetchPage = useCallback(
    async (pageOffset: number, replace: boolean) => {
      const { data, error: fetchError } = await supabase
        .from('notifications')
        .select('id, user_id, type, title, body, read_at, created_at, metadata')
        .order('created_at', { ascending: false })
        .range(pageOffset, pageOffset + PAGE_SIZE - 1);

      if (fetchError) {
        return { data: null, error: fetchError.message };
      }

      const filtered = (data ?? []).filter(
        (n: unknown) => !isSentinelRow(n as InAppNotification)
      ) as InAppNotification[];

      if (replace) {
        setNotifications(filtered);
      } else {
        setNotifications((prev) => [...prev, ...filtered]);
      }

      setHasMore(filtered.length === PAGE_SIZE);
      setOffset(pageOffset + filtered.length);

      return { data: filtered, error: null };
    },
    []
  );

  /**
   * Compute unread count from the current notification list.
   */
  const recomputeUnreadCount = useCallback((notifs: InAppNotification[]) => {
    setUnreadCount(notifs.filter((n) => !n.read_at).length);
  }, []);

  /**
   * Initial fetch and real-time subscription setup.
   */
  useEffect(() => {
    let mounted = true;

    async function init() {
      setLoading(true);
      setError(null);

      // Get current user ID for the channel name
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !mounted) return;

      const { error: fetchError } = await fetchPage(0, true);
      if (fetchError && mounted) {
        setError(fetchError);
      }

      // Re-compute unread count
      setNotifications((current) => {
        recomputeUnreadCount(current);
        return current;
      });

      if (mounted) setLoading(false);

      // Subscribe to real-time inserts on the notifications table
      // WHY: New push notifications arrive server-side; Realtime pushes them
      // to the mobile client so the feed updates without polling.
      const channel = supabase
        .channel(`${CHANNEL_PREFIX}:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`,
          },
          (payload: { new: Record<string, unknown> }) => {
            if (!mounted) return;
            const newNotif = payload.new as unknown as InAppNotification;
            if (isSentinelRow(newNotif)) return;

            setNotifications((prev) => {
              const updated = [newNotif, ...prev];
              recomputeUnreadCount(updated);
              return updated;
            });
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`,
          },
          (payload: { new: Record<string, unknown> }) => {
            if (!mounted) return;
            const updated = payload.new as unknown as InAppNotification;
            setNotifications((prev) => {
              const next = prev.map((n) => (n.id === updated.id ? updated : n));
              recomputeUnreadCount(next);
              return next;
            });
          }
        )
        .subscribe();

      channelRef.current = channel;
    }

    init();

    return () => {
      mounted = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [fetchPage, recomputeUnreadCount]);

  /**
   * Mark a single notification as read with optimistic update + rollback.
   *
   * @param id - The notification ID to mark as read
   */
  const markAsRead = useCallback(
    async (id: string) => {
      const now = new Date().toISOString();

      // Optimistic update
      setNotifications((prev) => {
        const updated = prev.map((n) =>
          n.id === id && !n.read_at ? { ...n, read_at: now } : n
        );
        recomputeUnreadCount(updated);
        return updated;
      });

      const { error: updateError } = await supabase
        .from('notifications')
        .update({ read_at: now })
        .eq('id', id)
        .is('read_at', null);

      if (updateError) {
        // Rollback on failure
        setNotifications((prev) => {
          const rolled = prev.map((n) =>
            n.id === id && n.read_at === now ? { ...n, read_at: null } : n
          );
          recomputeUnreadCount(rolled);
          return rolled;
        });
      }
    },
    [recomputeUnreadCount]
  );

  /**
   * Mark all unread notifications as read.
   * Uses a batch update with timestamp for atomicity.
   */
  const markAllAsRead = useCallback(async () => {
    const now = new Date().toISOString();

    // Optimistic update
    setNotifications((prev) => {
      const updated = prev.map((n) => (!n.read_at ? { ...n, read_at: now } : n));
      setUnreadCount(0);
      return updated;
    });

    const { error: updateError } = await supabase
      .from('notifications')
      .update({ read_at: now })
      .is('read_at', null);

    if (updateError) {
      // Rollback — re-fetch to get accurate state
      await fetchPage(0, true);
    }
  }, [fetchPage]);

  /**
   * Load the next page of notifications.
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await fetchPage(offset, false);
    setLoadingMore(false);
  }, [loadingMore, hasMore, fetchPage, offset]);

  /**
   * Re-fetch from the beginning, resetting pagination state.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setOffset(0);
    const { error: fetchError } = await fetchPage(0, true);
    if (fetchError) setError(fetchError);
    setLoading(false);
  }, [fetchPage]);

  return {
    notifications,
    unreadCount,
    loading,
    loadingMore,
    hasMore,
    error,
    markAsRead,
    markAllAsRead,
    loadMore,
    refresh,
  };
}
