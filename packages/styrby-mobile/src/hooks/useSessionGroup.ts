/**
 * useSessionGroup
 *
 * Subscribes to a single agent_session_group and its member sessions via
 * Supabase Realtime. Returns the group record, all member session summaries,
 * and a focus() action that calls POST /api/sessions/groups/[groupId]/focus.
 *
 * WHY a dedicated hook (not inlining in SessionGroupStrip):
 *   Multiple components may need to read the same group — the strip header,
 *   the session detail screen, and the dashboard card all want the group
 *   state. A single hook + subscription avoids N parallel Realtime channels
 *   for the same group ID. Consumers share state via Context or by the
 *   parent passing the hook result down.
 *
 * Realtime subscription strategy:
 *   - Subscribe to agent_session_groups:id=eq.{groupId} for focus changes
 *   - Subscribe to sessions:session_group_id=eq.{groupId} for member changes
 *   - Both subscriptions are cleaned up on unmount or groupId change
 *
 * WHY postgres_changes not broadcast:
 *   The mobile app should not miss state changes that happen while it's
 *   in the background (daemon focus CLI command, another mobile device,
 *   etc.). postgres_changes delivers a complete updated row on any INSERT/
 *   UPDATE, so the UI stays in sync even if it was offline briefly.
 *
 * @module hooks/useSessionGroup
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

/**
 * A member session within a group (subset of the sessions row).
 * We pull only the fields needed for the mobile strip card — not the full
 * session row, to keep payload size small.
 */
export interface GroupSession {
  /** Supabase session UUID */
  id: string;
  /** Agent type (e.g. 'claude') */
  agent_type: string;
  /** Session status */
  status: 'starting' | 'running' | 'idle' | 'paused' | 'stopped' | 'error' | 'expired';
  /** Working directory path */
  project_path: string | null;
  /**
   * Total token count (input + output) for cost indicator.
   * WHY computed not stored: sessions table has no total_tokens column.
   * This is derived client-side from total_input_tokens + total_output_tokens.
   */
  total_tokens: number | null;
  /** Total cost in USD — mapped from sessions.total_cost_usd */
  cost_usd: number | null;
  /** ISO 8601 start timestamp */
  started_at: string;
  /** ISO 8601 last activity timestamp */
  last_activity_at: string | null;
}

/**
 * Snapshot of an agent_session_group row.
 */
export interface SessionGroup {
  /** Group UUID */
  id: string;
  /** User-visible group name */
  name: string;
  /** UUID of the currently focused session (or null if none) */
  active_agent_session_id: string | null;
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** ISO 8601 last-updated timestamp */
  updated_at: string;
}

/**
 * Return value of useSessionGroup.
 */
export interface UseSessionGroupReturn {
  /** The group record, or null if not yet loaded */
  group: SessionGroup | null;
  /** Member sessions in this group */
  sessions: GroupSession[];
  /** Whether the initial data load is in progress */
  loading: boolean;
  /** Error message if the load or subscription failed */
  error: string | null;
  /**
   * Focus a specific session in the group.
   * Calls POST /api/sessions/groups/[groupId]/focus and optimistically
   * updates local state before the server responds.
   *
   * @param sessionId - Session to focus
   */
  focus: (sessionId: string) => Promise<void>;
  /**
   * Manually refetch the group + sessions from Supabase.
   * Useful after recovering from a network error.
   */
  refetch: () => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Subscribe to an agent_session_group and its member sessions.
 *
 * @param groupId - UUID of the agent_session_group to subscribe to.
 *                  Pass null/undefined to disable the hook (returns empty state).
 * @returns UseSessionGroupReturn with group state + focus action
 *
 * @example
 * function GroupScreen({ groupId }: { groupId: string }) {
 *   const { group, sessions, loading, focus } = useSessionGroup(groupId);
 *
 *   if (loading) return <LoadingSpinner />;
 *   if (!group) return <Text>Group not found</Text>;
 *
 *   return (
 *     <SessionGroupStrip
 *       group={group}
 *       sessions={sessions}
 *       onFocus={focus}
 *     />
 *   );
 * }
 */
export function useSessionGroup(groupId: string | null | undefined): UseSessionGroupReturn {
  const [group, setGroup] = useState<SessionGroup | null>(null);
  const [sessions, setSessions] = useState<GroupSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hold refs to active Realtime channels for cleanup
  const groupChannelRef = useRef<RealtimeChannel | null>(null);
  const sessionsChannelRef = useRef<RealtimeChannel | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  /**
   * Fetch the group record and its member sessions from Supabase.
   *
   * WHY separate selects (not a join): Supabase JS v2 does not support
   * cross-table filters in a single .from() call. We fetch the group first,
   * then the sessions with session_group_id = groupId.
   */
  const fetchGroupData = useCallback(async () => {
    if (!groupId) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch group record
      const { data: groupData, error: groupFetchError } = await supabase
        .from('agent_session_groups')
        .select('id, name, active_agent_session_id, created_at, updated_at')
        .eq('id', groupId)
        .single();

      if (groupFetchError) {
        setError(`Failed to load group: ${groupFetchError.message}`);
        return;
      }

      setGroup(groupData as SessionGroup);

      // Fetch member sessions
      // WHY total_input_tokens + total_output_tokens (not total_tokens): sessions
      // table has no total_tokens column. We select the two canonical columns and
      // sum them into GroupSession.total_tokens at the boundary. H27 drift fix.
      // WHY total_cost_usd (not cost_usd): canonical column name is total_cost_usd. H27.
      const { data: rawSessionData, error: sessionFetchError } = await supabase
        .from('sessions')
        .select(
          'id, agent_type, status, project_path, total_input_tokens, total_output_tokens, total_cost_usd, started_at, last_activity_at'
        )
        .eq('session_group_id', groupId)
        .order('started_at', { ascending: true });

      if (sessionFetchError) {
        setError(`Failed to load sessions: ${sessionFetchError.message}`);
        return;
      }

      // Adapt DB column names to GroupSession shape (H27 boundary mapping).
      const sessionData: GroupSession[] = (rawSessionData ?? []).map((row) => ({
        id: row.id,
        agent_type: row.agent_type,
        status: row.status,
        project_path: row.project_path,
        total_tokens:
          row.total_input_tokens != null || row.total_output_tokens != null
            ? (row.total_input_tokens ?? 0) + (row.total_output_tokens ?? 0)
            : null,
        cost_usd: row.total_cost_usd ?? null,
        started_at: row.started_at,
        last_activity_at: row.last_activity_at,
      }));

      setSessions(sessionData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error fetching group';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  // ── Initial fetch + Realtime subscriptions ─────────────────────────────────

  useEffect(() => {
    if (!groupId) {
      // Clear state when groupId is cleared
      setGroup(null);
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Initial data load
    fetchGroupData();

    // ── Subscribe to group record changes (focus updates) ────────────────────
    // WHY: When another device (CLI or second mobile) calls the focus API,
    // active_agent_session_id changes on the server. We need to reflect that
    // immediately in the strip without polling.
    const groupChannel = supabase
      .channel(`session-group:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agent_session_groups',
          filter: `id=eq.${groupId}`,
        },
        (payload) => {
          // WHY full replace (not partial merge): the payload.new contains the
          // full updated row from Postgres. Merging partial updates risks showing
          // stale fields if the client and server clocks diverge.
          setGroup(payload.new as SessionGroup);
        }
      )
      .subscribe();

    groupChannelRef.current = groupChannel;

    // ── Subscribe to member session changes (status, cost, etc.) ────────────
    const sessionsChannel = supabase
      .channel(`session-group-sessions:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // INSERT covers rare re-assignment; UPDATE covers status/cost
          schema: 'public',
          table: 'sessions',
          filter: `session_group_id=eq.${groupId}`,
        },
        (payload) => {
          const updated = payload.new as GroupSession;

          setSessions((prev) => {
            // Upsert: replace existing row or append new one
            const idx = prev.findIndex((s) => s.id === updated.id);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = updated;
              return next;
            }
            return [...prev, updated];
          });
        }
      )
      .subscribe();

    sessionsChannelRef.current = sessionsChannel;

    // Cleanup on unmount or groupId change
    return () => {
      groupChannel.unsubscribe();
      sessionsChannel.unsubscribe();
      groupChannelRef.current = null;
      sessionsChannelRef.current = null;
    };
  }, [groupId, fetchGroupData]);

  // ── Focus action ───────────────────────────────────────────────────────────

  /**
   * Focus a session within this group.
   *
   * Optimistically updates local state so the UI responds immediately.
   * Reverts the optimistic update on API failure.
   *
   * @param sessionId - Session to focus
   * @throws Never — errors are captured into the error state
   */
  const focus = useCallback(
    async (sessionId: string) => {
      if (!groupId || !group) return;

      // Optimistic update
      const previous = group.active_agent_session_id;
      setGroup((prev) =>
        prev ? { ...prev, active_agent_session_id: sessionId } : prev
      );

      try {
        const response = await fetch(`/api/sessions/groups/${groupId}/focus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ message: 'Unknown error' }));
          throw new Error(body.message ?? `Focus failed: HTTP ${response.status}`);
        }
      } catch (err) {
        // Revert optimistic update on failure
        setGroup((prev) =>
          prev ? { ...prev, active_agent_session_id: previous } : prev
        );
        const msg = err instanceof Error ? err.message : 'Focus update failed';
        setError(msg);
      }
    },
    [groupId, group]
  );

  return {
    group,
    sessions,
    loading,
    error,
    focus,
    refetch: fetchGroupData,
  };
}
