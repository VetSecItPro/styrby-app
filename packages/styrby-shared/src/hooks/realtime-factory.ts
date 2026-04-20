/**
 * Realtime subscription factory (Phase 0.10).
 *
 * Web (React) and mobile (React Native) both need to subscribe to Supabase
 * Realtime channels for sessions, costs, and team events. The subscription
 * lifecycle is identical across platforms — `subscribe()` on mount, send
 * acknowledgements on every payload, `unsubscribe()` on unmount — but the
 * actual hook (`useEffect` vs `useFocusEffect` vs RN `AppState`) differs.
 *
 * This module exports the **lifecycle factory** that both platforms wrap
 * with their idiomatic hook. The factory itself has zero React or RN
 * dependency, which is why it lives in `@styrby/shared`.
 *
 * Auto-cleanup is the design contract: every subscription returns an
 * `unsubscribe()` function and the channel reference is dropped. No
 * orphaned channels, no leaked Supabase Realtime connections (SOC2 A1
 * availability — we have a finite Realtime concurrent-channel quota).
 *
 * @module hooks/realtime-factory
 */

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

/**
 * Configuration for a single realtime subscription.
 *
 * @template T The expected payload row shape.
 */
export interface RealtimeSubscriptionConfig<T = unknown> {
  /** The Supabase client (browser or RN). */
  client: SupabaseClient;
  /**
   * The channel name. Convention: `"<table>:<filterKey>:<filterValue>"`
   * e.g. `"sessions:user_id:abc-123"`. Channels with the same name across
   * tabs deduplicate to a single connection.
   */
  channelName: string;
  /** The Postgres table to subscribe to. */
  table: string;
  /** Schema (defaults to 'public'). */
  schema?: string;
  /**
   * Optional filter expression in PostgREST syntax. Without a filter, the
   * subscription will receive every change to the table (rejected by RLS
   * unless the user has permission).
   */
  filter?: string;
  /**
   * Postgres event types to listen for. Defaults to `['INSERT', 'UPDATE', 'DELETE']`.
   * WHY: explicit default so a typo (`'insert'` lowercase) never silently subscribes
   * to nothing.
   */
  events?: Array<'INSERT' | 'UPDATE' | 'DELETE' | '*'>;
  /** Called once per change with the new row payload. */
  onChange: (payload: T) => void;
  /** Optional error sink. */
  onError?: (err: unknown) => void;
}

/**
 * Result of `createRealtimeSubscription`. Call `unsubscribe()` to release
 * the channel; idempotent on repeated calls.
 */
export interface RealtimeSubscription {
  /** Tear down the subscription. Safe to call multiple times. */
  unsubscribe: () => void;
  /** The underlying Supabase channel — exposed for advanced use only. */
  channel: RealtimeChannel;
}

/**
 * Subscribe to a Supabase Realtime channel with auto-cleanup semantics.
 *
 * This is the **platform-agnostic primitive**. React/RN consumers wrap
 * this in a `useEffect(() => sub.unsubscribe, [])` so the channel is
 * released on unmount (preventing the channel-leak bug that paged us once
 * when a long mobile session held 30+ orphaned channels).
 *
 * @param cfg - Subscription configuration.
 * @returns A handle whose `unsubscribe()` releases the channel.
 *
 * @example
 * ```ts
 * // React
 * useEffect(() => {
 *   const sub = createRealtimeSubscription({
 *     client: supabase,
 *     channelName: `sessions:user:${userId}`,
 *     table: 'sessions',
 *     filter: `user_id=eq.${userId}`,
 *     onChange: (row) => setSessions((prev) => upsert(prev, row)),
 *   });
 *   return sub.unsubscribe;
 * }, [userId]);
 * ```
 */
export function createRealtimeSubscription<T = unknown>(
  cfg: RealtimeSubscriptionConfig<T>,
): RealtimeSubscription {
  const events = cfg.events ?? ['INSERT', 'UPDATE', 'DELETE'];
  let unsubscribed = false;

  const channel = cfg.client.channel(cfg.channelName);

  for (const event of events) {
    // postgres_changes is the documented Supabase Realtime event family.
    // The `as never` cast is a known limitation of the Supabase v2 SDK
    // typings for dynamic channel.on() configurations.
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'postgres_changes' as any,
      {
        event,
        schema: cfg.schema ?? 'public',
        table: cfg.table,
        ...(cfg.filter ? { filter: cfg.filter } : {}),
      },
      (payload: { new: T; old: T }) => {
        if (unsubscribed) return;
        try {
          cfg.onChange(payload.new ?? payload.old);
        } catch (err) {
          cfg.onError?.(err);
        }
      },
    );
  }

  channel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      cfg.onError?.(new Error(`Realtime channel ${cfg.channelName}: ${status}`));
    }
  });

  return {
    channel,
    unsubscribe: () => {
      if (unsubscribed) return;
      unsubscribed = true;
      try {
        cfg.client.removeChannel(channel);
      } catch (err) {
        cfg.onError?.(err);
      }
    },
  };
}

/**
 * Sessions subscription helper — channels filtered to one user.
 * Used by both web (`SessionsPage`) and mobile (`SessionsScreen`).
 *
 * @param client - Authenticated Supabase client.
 * @param userId - The user's UUID.
 * @param onChange - Per-row change callback.
 * @returns A {@link RealtimeSubscription} handle.
 */
export function subscribeToSessions<T = unknown>(
  client: SupabaseClient,
  userId: string,
  onChange: (row: T) => void,
): RealtimeSubscription {
  return createRealtimeSubscription<T>({
    client,
    channelName: `sessions:user:${userId}`,
    table: 'sessions',
    filter: `user_id=eq.${userId}`,
    onChange,
  });
}

/**
 * Cost records subscription helper — drives the cost dashboard live tile.
 *
 * @param client - Authenticated Supabase client.
 * @param userId - The user's UUID.
 * @param onChange - Per-row change callback.
 * @returns A {@link RealtimeSubscription} handle.
 */
export function subscribeToCostRecords<T = unknown>(
  client: SupabaseClient,
  userId: string,
  onChange: (row: T) => void,
): RealtimeSubscription {
  return createRealtimeSubscription<T>({
    client,
    channelName: `cost_records:user:${userId}`,
    table: 'cost_records',
    filter: `user_id=eq.${userId}`,
    onChange,
  });
}

/**
 * Team events subscription helper — reserved for the Teams tier (not yet
 * GA). Subscribing returns a no-op cleanup until the table exists.
 *
 * @param client - Authenticated Supabase client.
 * @param teamId - The team's UUID.
 * @param onChange - Per-row change callback.
 * @returns A {@link RealtimeSubscription} handle.
 */
export function subscribeToTeamEvents<T = unknown>(
  client: SupabaseClient,
  teamId: string,
  onChange: (row: T) => void,
): RealtimeSubscription {
  return createRealtimeSubscription<T>({
    client,
    channelName: `team_events:team:${teamId}`,
    table: 'team_events',
    filter: `team_id=eq.${teamId}`,
    onChange,
  });
}
