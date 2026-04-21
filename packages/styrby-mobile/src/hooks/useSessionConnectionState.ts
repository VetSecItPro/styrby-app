/**
 * useSessionConnectionState — daemon connection-state hook.
 *
 * Subscribes to a Supabase Realtime presence channel for live status updates
 * from the CLI relay, and falls back to polling the `sessions` table every
 * 30 s when presence is silent.  Computes `'offline'` whenever `last_seen_at`
 * is older than 60 s, even without a presence event, to give users a graceful
 * UX during temporary disconnects.
 *
 * WHY polling fallback: Supabase Realtime presence tracks online clients; once
 * the relay daemon closes its socket the browser's presence entry is removed.
 * However the relay may go quiet without cleanly closing (network partition,
 * process kill), so presence alone is insufficient.  Polling `last_seen_at`
 * — updated on every RelayClient event by PR #115 — gives a durable signal.
 *
 * @module hooks/useSessionConnectionState
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ============================================================================
// Constants
// ============================================================================

/** How old last_seen_at must be (ms) before we declare the session offline. */
const OFFLINE_THRESHOLD_MS = 60_000;

/** Polling interval (ms) when presence is silent. */
const POLL_INTERVAL_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Connection status derived from Realtime presence + last_seen_at polling.
 *
 * - `'connected'`    — daemon is live; last presence event or DB heartbeat was
 *                       within OFFLINE_THRESHOLD_MS.
 * - `'reconnecting'` — daemon sent a `reconnecting` event (PR #114); the
 *                       relay is mid back-off loop.
 * - `'offline'`      — no heartbeat within OFFLINE_THRESHOLD_MS.
 * - `'unknown'`      — initial state before the first data arrives.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline' | 'unknown';

/**
 * Shape returned by {@link useSessionConnectionState}.
 */
export interface SessionConnectionState {
  /** Current interpreted connection status. */
  status: ConnectionStatus;
  /** Timestamp of the last known daemon activity, or null if unavailable. */
  lastSeenAt: Date | null;
  /**
   * Reconnect attempt counter from the relay's `reconnecting` event.
   * Only present when status === 'reconnecting'.
   */
  attempt?: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns live connection state for a specific session's daemon relay.
 *
 * Inputs: `sessionId` — the Supabase `sessions.id` to track.
 *
 * Outputs: `{ status, lastSeenAt, attempt? }`.
 *
 * @param sessionId - The session ID to monitor
 * @returns Current connection state
 *
 * @example
 * const { status, lastSeenAt } = useSessionConnectionState('abc-123');
 */
export function useSessionConnectionState(sessionId: string): SessionConnectionState {
  const [state, setState] = useState<SessionConnectionState>({
    status: 'unknown',
    lastSeenAt: null,
  });

  /**
   * Ref to the active Realtime channel so we can unsubscribe on cleanup.
   */
  const channelRef = useRef<RealtimeChannel | null>(null);

  /**
   * Ref to the polling interval timer.
   */
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Derive a `ConnectionStatus` from a `last_seen_at` timestamp.
   * Returns `'offline'` if the timestamp is older than OFFLINE_THRESHOLD_MS.
   * Returns `'connected'` if recent.
   *
   * @param lastSeen - ISO timestamp from DB
   */
  const deriveStatusFromTimestamp = useCallback(
    (lastSeen: string | null): ConnectionStatus => {
      if (!lastSeen) return 'unknown';
      const ageMs = Date.now() - new Date(lastSeen).getTime();
      return ageMs > OFFLINE_THRESHOLD_MS ? 'offline' : 'connected';
    },
    [],
  );

  /**
   * Poll the `sessions` table for `last_seen_at` and `status`.
   * Used as the fallback when presence is silent.
   */
  const pollSessionState = useCallback(async () => {
    const { data, error } = await supabase
      .from('sessions')
      .select('last_seen_at, status')
      .eq('id', sessionId)
      .single();

    if (error || !data) return;

    const lastSeen = (data as { last_seen_at?: string | null; status?: string }).last_seen_at ?? null;
    const dbStatus = (data as { status?: string }).status ?? null;

    // WHY: If the DB status itself is 'reconnecting' honour it directly so the
    // badge remains accurate even when presence events are not arriving.
    let newStatus: ConnectionStatus;
    if (dbStatus === 'reconnecting') {
      newStatus = 'reconnecting';
    } else {
      newStatus = deriveStatusFromTimestamp(lastSeen);
    }

    setState((prev) => ({
      ...prev,
      status: newStatus,
      lastSeenAt: lastSeen ? new Date(lastSeen) : prev.lastSeenAt,
      // Clear attempt counter when polling resolves non-reconnecting state
      attempt: newStatus === 'reconnecting' ? prev.attempt : undefined,
    }));
  }, [sessionId, deriveStatusFromTimestamp]);

  useEffect(() => {
    if (!sessionId) return;

    // ── 1. Initial DB fetch ──────────────────────────────────────────────────
    pollSessionState();

    // ── 2. Realtime presence subscription ───────────────────────────────────
    // WHY: We subscribe to the session-presence channel that the relay daemon
    // broadcasts to.  Presence payloads carry `status` and optionally `attempt`
    // when the daemon fires a `reconnecting` event (PR #114).
    const channelName = `session-presence:${sessionId}`;
    const channel = supabase.channel(channelName);

    channel
      .on('presence', { event: 'sync' }, () => {
        // On sync, inspect the full presence state for this session's key.
        const presenceState = channel.presenceState<{
          status?: string;
          last_seen_at?: string;
          attempt?: number;
        }>();

        // The daemon joins with its session ID as the presence key.
        const presences = Object.values(presenceState).flat();
        if (presences.length === 0) {
          // No presence entries — daemon has left; fall through to poll result.
          return;
        }

        // Use the most recent presence entry.
        const latest = presences[presences.length - 1];
        const rawStatus = latest?.status;
        const rawLastSeen = latest?.last_seen_at ?? null;
        const rawAttempt = latest?.attempt;

        let newStatus: ConnectionStatus = 'unknown';
        if (rawStatus === 'reconnecting') {
          newStatus = 'reconnecting';
        } else if (rawStatus === 'connected' || rawStatus === 'running' || rawStatus === 'idle') {
          newStatus = deriveStatusFromTimestamp(rawLastSeen ?? new Date().toISOString());
        } else if (rawLastSeen) {
          newStatus = deriveStatusFromTimestamp(rawLastSeen);
        }

        setState({
          status: newStatus,
          lastSeenAt: rawLastSeen ? new Date(rawLastSeen) : null,
          attempt: rawStatus === 'reconnecting' ? rawAttempt : undefined,
        });
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        // WHY: `join` fires when the daemon first connects or re-connects.
        const p = (newPresences as Array<{ status?: string; last_seen_at?: string; attempt?: number }>)[0];
        if (!p) return;

        const rawStatus = p.status;
        const rawLastSeen = p.last_seen_at ?? null;

        let newStatus: ConnectionStatus =
          rawStatus === 'reconnecting' ? 'reconnecting' : 'connected';

        if (newStatus === 'connected' && rawLastSeen) {
          newStatus = deriveStatusFromTimestamp(rawLastSeen);
        }

        setState({
          status: newStatus,
          lastSeenAt: rawLastSeen ? new Date(rawLastSeen) : new Date(),
          attempt: rawStatus === 'reconnecting' ? p.attempt : undefined,
        });
      })
      .on('presence', { event: 'leave' }, () => {
        // WHY: `leave` fires when the daemon disconnects cleanly.  We mark
        // offline immediately rather than waiting 60 s for the poll fallback.
        setState((prev) => ({
          ...prev,
          status: 'offline',
          attempt: undefined,
        }));
      })
      .subscribe();

    channelRef.current = channel;

    // ── 3. Polling fallback ──────────────────────────────────────────────────
    // WHY: Presence may be silent for network-partitioned daemons.  Poll every
    // 30 s so `last_seen_at` drift is surfaced promptly.
    pollTimerRef.current = setInterval(pollSessionState, POLL_INTERVAL_MS);

    return () => {
      // Cleanup: unsubscribe from Realtime and stop polling.
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [sessionId, pollSessionState, deriveStatusFromTimestamp]);

  return state;
}
