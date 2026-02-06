'use client';

import { useEffect, useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

/**
 * Types of Postgres changes that can be subscribed to.
 * Use '*' to subscribe to all event types.
 */
type SubscriptionEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

/**
 * Configuration options for the real-time subscription hook.
 *
 * @template T - The shape of the database record being subscribed to
 */
interface UseRealtimeOptions<T> {
  /**
   * The name of the table to subscribe to changes on.
   *
   * @example 'sessions'
   */
  table: string;

  /**
   * The database schema containing the table.
   * Defaults to 'public'.
   */
  schema?: string;

  /**
   * The type of event to listen for.
   * Defaults to '*' (all events).
   */
  event?: SubscriptionEvent;

  /**
   * Optional filter to narrow down which rows to receive updates for.
   * Uses Supabase filter syntax.
   *
   * @example 'user_id=eq.123abc-456def'
   */
  filter?: string;

  /**
   * Callback invoked when a new row is inserted.
   *
   * @param payload - The newly inserted record
   */
  onInsert?: (payload: T) => void;

  /**
   * Callback invoked when an existing row is updated.
   *
   * @param payload - The updated record
   */
  onUpdate?: (payload: T) => void;

  /**
   * Callback invoked when a row is deleted.
   *
   * @param payload - The deleted record (from the 'old' field)
   */
  onDelete?: (payload: T) => void;
}

/**
 * Return type for the useRealtimeSubscription hook.
 */
interface UseRealtimeReturn {
  /**
   * Whether the WebSocket channel is currently connected and subscribed.
   */
  isConnected: boolean;

  /**
   * Any error that occurred during subscription setup or maintenance.
   */
  error: Error | null;
}

/**
 * Hook for subscribing to real-time Postgres changes via Supabase Realtime.
 *
 * WHY: The web dashboard needs to show live updates (new sessions, cost changes)
 * without requiring manual refresh. This hook encapsulates the subscription
 * lifecycle and provides connection state for UI indicators.
 *
 * @template T - The shape of the database record being subscribed to
 * @param options - Configuration for the subscription
 * @returns Connection state and any errors
 *
 * @example
 * const { isConnected } = useRealtimeSubscription<Session>({
 *   table: 'sessions',
 *   filter: `user_id=eq.${userId}`,
 *   onInsert: (session) => setSessions(prev => [session, ...prev]),
 *   onUpdate: (session) => setSessions(prev =>
 *     prev.map(s => s.id === session.id ? session : s)
 *   ),
 * });
 */
export function useRealtimeSubscription<T extends Record<string, any>>({
  table,
  schema = 'public',
  event = '*',
  filter,
  onInsert,
  onUpdate,
  onDelete,
}: UseRealtimeOptions<T>): UseRealtimeReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // WHY: We use refs for callbacks to avoid re-subscribing when callbacks change.
  // The subscription setup is expensive, so we only want to do it once per
  // table/filter combination.
  const callbacksRef = useRef({ onInsert, onUpdate, onDelete });

  // Update ref in effect to avoid lint error about updating refs during render
  useEffect(() => {
    callbacksRef.current = { onInsert, onUpdate, onDelete };
  }, [onInsert, onUpdate, onDelete]);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;

    /**
     * Sets up the WebSocket channel and subscribes to Postgres changes.
     */
    const setupSubscription = () => {
      // WHY: Channel names must be unique per subscription to avoid conflicts.
      // We include the filter in the name to allow multiple subscriptions to
      // the same table with different filters.
      const channelName = `realtime:${table}:${filter || 'all'}`;

      channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          {
            event,
            schema,
            table,
            filter,
          },
          (payload: RealtimePostgresChangesPayload<T>) => {
            const record = payload.new as T;
            const oldRecord = payload.old as T;

            switch (payload.eventType) {
              case 'INSERT':
                callbacksRef.current.onInsert?.(record);
                break;
              case 'UPDATE':
                callbacksRef.current.onUpdate?.(record);
                break;
              case 'DELETE':
                callbacksRef.current.onDelete?.(oldRecord);
                break;
            }
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setIsConnected(true);
            setError(null);
          } else if (status === 'CHANNEL_ERROR') {
            setIsConnected(false);
            setError(new Error(`Failed to subscribe to real-time updates for ${table}`));
          } else if (status === 'CLOSED') {
            setIsConnected(false);
          }
        });
    };

    setupSubscription();

    // Cleanup: remove channel on unmount or dependency change
    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [table, schema, event, filter]);

  return { isConnected, error };
}
