'use client';

import { useState, useCallback } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { ConnectionStatus } from '@/components/connection-status';
import { SessionsFilter } from './sessions-filter';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a coding session from the database.
 * Matches the shape returned by the Supabase query.
 */
interface Session {
  /** Unique session identifier */
  id: string;
  /** User-defined session title */
  title: string | null;
  /** Which AI agent was used ('claude' | 'codex' | 'gemini') */
  agent_type: string;
  /** Current session status ('running' | 'idle' | 'ended') */
  status: string;
  /** Cumulative cost in USD */
  total_cost_usd: number;
  /** Number of messages exchanged */
  message_count: number;
  /** ISO 8601 timestamp of session creation */
  created_at: string;
  /** AI-generated summary of the session */
  summary: string | null;
  /** User-applied tags */
  tags: string[] | null;
}

/**
 * Props for the SessionsRealtime component.
 */
interface SessionsRealtimeProps {
  /**
   * Initial sessions fetched from the server during SSR.
   */
  initialSessions: Session[];

  /**
   * The authenticated user's ID for filtering real-time updates.
   */
  userId: string;
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Client component wrapper that adds real-time subscription to the sessions list.
 *
 * WHY: The sessions page needs to show live updates when sessions are created,
 * updated, or ended. This component manages the real-time subscription and
 * optimistically updates the local state, while delegating filtering and
 * display to the SessionsFilter component.
 *
 * @param props - Component props including initial sessions and user ID
 * @returns Sessions list with real-time updates and connection status indicator
 *
 * @example
 * // In the server component:
 * <SessionsRealtime initialSessions={sessions} userId={user.id} />
 */
export function SessionsRealtime({ initialSessions, userId }: SessionsRealtimeProps) {
  const [sessions, setSessions] = useState(initialSessions);

  /**
   * Handles new session insertions by prepending to the list.
   * WHY: Newest sessions should appear at the top for visibility.
   */
  const handleInsert = useCallback((newSession: Session) => {
    setSessions((prev) => [newSession, ...prev]);
  }, []);

  /**
   * Handles session updates by replacing the matching session in the list.
   * WHY: We need to update status, cost, and message count in real-time.
   */
  const handleUpdate = useCallback((updatedSession: Session) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
    );
  }, []);

  /**
   * Handles session deletions by removing from the list.
   * WHY: Deleted sessions should immediately disappear from the UI.
   */
  const handleDelete = useCallback((deletedSession: Session) => {
    setSessions((prev) => prev.filter((s) => s.id !== deletedSession.id));
  }, []);

  const { isConnected } = useRealtimeSubscription<Session>({
    table: 'sessions',
    filter: `user_id=eq.${userId}`,
    onInsert: handleInsert,
    onUpdate: handleUpdate,
    onDelete: handleDelete,
  });

  return (
    <>
      {/* Connection status indicator - positioned in the top-right of the header area */}
      <div className="flex items-center justify-end mb-4">
        <ConnectionStatus isConnected={isConnected} />
      </div>

      {/* Delegate filtering and display to the existing SessionsFilter component */}
      <SessionsFilter sessions={sessions} />
    </>
  );
}
