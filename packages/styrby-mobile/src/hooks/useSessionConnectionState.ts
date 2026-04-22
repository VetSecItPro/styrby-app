/**
 * useSessionConnectionState
 *
 * Wraps `useRelay` and adds reconnect telemetry: how many times the relay
 * has tried to reconnect in the current session, and when the most recent
 * attempt started.
 *
 * WHY a separate hook instead of adding fields to useRelay:
 *   useRelay is a low-level transport hook. Adding UI-layer telemetry fields
 *   would couple the transport layer to presentation concerns. This wrapper
 *   keeps separation of concerns clean — transport in useRelay, telemetry in
 *   useSessionConnectionState, display in ConnectionStateBadge.
 *
 * WHY track attempt count vs just lastAttemptAt:
 *   The mobile UI shows "attempt N, last try Xs ago". Both pieces of
 *   information together give the user a clearer picture of persistence
 *   vs. a single timestamp. Users who see "attempt 1, 2s ago" know this
 *   is a fresh blip; "attempt 5, 30s ago" signals something more serious.
 *
 * Reconnect counting rules:
 *   - Transition to 'connecting' or 'reconnecting' → increment attempt count
 *     and record lastAttemptAt.
 *   - Transition to 'connected' → reset attempt count to 0 and lastAttemptAt
 *     to null (clean success clears telemetry).
 *   - Transition to 'disconnected' or 'error' → do NOT increment (these are
 *     passive states, not active reconnect attempts).
 *
 * @module hooks/useSessionConnectionState
 */

import { useState, useEffect, useRef } from 'react';
import { useRelay, type UseRelayReturn } from './useRelay';
import type { ConnectionState } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Extended relay state that includes reconnect telemetry fields.
 * All fields from UseRelayReturn are re-exported unchanged.
 */
export interface UseSessionConnectionStateReturn extends UseRelayReturn {
  /**
   * Number of reconnect attempts in the current session since the last
   * successful connection. Resets to 0 on 'connected'.
   */
  attempt: number;

  /**
   * ISO 8601 timestamp of the most recent reconnect attempt start, or
   * null if no reconnect has been attempted since the last connection.
   */
  lastAttemptAt: string | null;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Relay connection state hook with reconnect telemetry.
 *
 * @returns All fields from useRelay plus `attempt` and `lastAttemptAt`.
 *
 * @example
 * function SessionHeader() {
 *   const { connectionState, attempt, lastAttemptAt } = useSessionConnectionState();
 *   return (
 *     <ConnectionStateBadge
 *       connectionState={connectionState}
 *       attempt={attempt}
 *       lastAttemptAt={lastAttemptAt}
 *     />
 *   );
 * }
 */
export function useSessionConnectionState(): UseSessionConnectionStateReturn {
  const relay = useRelay();

  const [attempt, setAttempt] = useState(0);
  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);

  /**
   * WHY prevStateRef instead of including connectionState in the dep array
   * of a regular comparator:
   *   We need to detect *transitions* (from state A to state B), not just
   *   the current state value. Storing the previous state in a ref lets us
   *   compare old vs new in the same effect run without needing two separate
   *   effects or re-renders.
   */
  const prevStateRef = useRef<ConnectionState>(relay.connectionState);

  useEffect(() => {
    const prev = prevStateRef.current;
    const next = relay.connectionState;

    if (prev !== next) {
      if (next === 'connected') {
        // WHY reset on connected: a successful connection means the previous
        // attempts succeeded. Resetting gives a clean baseline for any future
        // reconnect cycle.
        setAttempt(0);
        setLastAttemptAt(null);
      } else if (next === 'connecting' || next === 'reconnecting') {
        // WHY increment only on connecting/reconnecting and not on
        // disconnected/error: 'disconnected' is a passive state (e.g., user
        // explicitly disconnected), and 'error' is a terminal state — neither
        // represents the relay actively trying to reach the daemon.
        setAttempt((prev) => prev + 1);
        setLastAttemptAt(new Date().toISOString());
      }

      prevStateRef.current = next;
    }
  }, [relay.connectionState]);

  return {
    ...relay,
    attempt,
    lastAttemptAt,
  };
}
