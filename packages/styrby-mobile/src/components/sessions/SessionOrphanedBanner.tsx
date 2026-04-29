/**
 * SessionOrphanedBanner
 *
 * Renders an amber warning banner when a session appears "orphaned" —
 * meaning the CLI that owned it was logged out or lost connectivity long
 * enough that its heartbeat has gone cold while the session is still marked
 * active in Supabase.
 *
 * WHY "orphaned" instead of "stale":
 *   The root cause is not generic staleness — it's specifically that the CLI
 *   process that owned the session disconnected without cleanly terminating the
 *   session. "Orphaned" communicates the causal relationship to developers and
 *   aligns with Phase 1 spec language (account-switch-correctness).
 *
 * WHY 90s heartbeat threshold:
 *   The CLI daemon emits heartbeats every 30s. Three missed heartbeats (90s)
 *   signals the daemon is definitively gone rather than briefly busy. Shorter
 *   thresholds cause false positives during transient network blips. This value
 *   must stay in sync with the CLI daemon's heartbeat interval and the
 *   `isOrphaned` check in the Supabase RLS / cron cleanup job.
 *
 * WHY amber / yellow instead of red:
 *   Per spec: "this is a recoverable state, not a fatal error." Red implies
 *   immediate action is required. Amber communicates "something changed;
 *   you have a decision to make." The user can dismiss and keep the session
 *   record, or end it — neither path causes data loss.
 *
 * Security citations:
 * - OWASP A07:2021 (Identification and Authentication Failures): account-switch
 *   scenarios can leave sessions bound to a different identity. This banner
 *   surfaces the evidence so the user can take corrective action.
 * - SOC 2 CC6.1 (Logical Access Controls): users retain control over session
 *   lifecycle; the "End Session" action enforces the principle of least-privilege
 *   by terminating a session no longer under the expected user's control.
 * - GDPR Art. 17 (Right to Erasure) / Art. 7 (Right to Withdraw Consent):
 *   "End Session" gives the data subject a direct path to terminate an active
 *   processing session from their own device.
 *
 * @module components/sessions/SessionOrphanedBanner
 */

import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from '../../lib/supabase';
import type { SessionStatus } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * A session is considered orphaned if its last heartbeat is older than this.
 *
 * WHY 90_000ms: CLI heartbeat interval is 30s. Three missed beats (3 × 30s = 90s)
 * provides a reliable signal that the daemon process is gone rather than
 * transiently slow. See `daemonProcess.ts` HEARTBEAT_INTERVAL_MS.
 */
const ORPHAN_HEARTBEAT_THRESHOLD_MS = 90_000;

/**
 * Session statuses that can produce an orphaned session.
 * Only active-lifecycle statuses can become orphaned — terminal statuses
 * like 'stopped' or 'expired' are already ended and need no banner.
 *
 * WHY: 'completed' and 'ended' are not valid SessionStatus values in this
 * codebase (see styrby-shared/src/types.ts). Active statuses are the set
 * defined by the shared type: starting, running, idle.
 * WHY 'paused' is excluded: SessionStatus = 'starting' | 'running' | 'idle' |
 * 'stopped' | 'error'. 'paused' is not in the union; including it would be
 * dead code that TypeScript cannot guard against at the Set boundary.
 */
const ACTIVE_STATUSES = new Set<SessionStatus>(['starting', 'running', 'idle']);

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the SessionOrphanedBanner component.
 */
export interface SessionOrphanedBannerProps {
  /**
   * The session's Supabase UUID, used as the predicate when calling
   * `supabase.from('sessions').update(...).eq('id', sessionId)`.
   */
  sessionId: string;

  /**
   * Current lifecycle status of the session.
   * The banner only renders when this is an active status (starting, running,
   * idle) AND lastHeartbeatAt is stale.
   * Typed as SessionStatus so TypeScript catches any future invalid values
   * at compile time — the same guard that was missing when 'paused' slipped in.
   */
  status: SessionStatus;

  /**
   * ISO 8601 timestamp of the most recent CLI heartbeat for this session,
   * or null if no heartbeat has ever been recorded.
   *
   * WHY nullable: Sessions created before the heartbeat feature shipped
   * will have null. We treat null as "never received a heartbeat", which
   * means we cannot conclusively determine orphan state — so we don't show
   * the banner. Better to miss a true orphan than to show false positives.
   */
  lastHeartbeatAt: string | null;

  /**
   * Optional clock provider for deterministic time control in tests.
   * Defaults to () => Date.now() in production.
   *
   * WHY: Injecting the clock as a prop eliminates real-clock dependency in
   * boundary tests. Without this, 89s-vs-90s threshold tests pass a
   * real-clock-relative offset that can drift on slow CI runners and produce
   * intermittent failures. Injecting a fixed timestamp makes the test
   * deterministic regardless of test runner speed.
   *
   * @example
   * // In a test:
   * const fixedNow = 1_700_000_000_000;
   * <SessionOrphanedBanner
   *   timeProvider={() => fixedNow}
   *   lastHeartbeatAt={new Date(fixedNow - 91_000).toISOString()}
   *   ...
   * />
   */
  timeProvider?: () => number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Determines whether a session should be treated as orphaned.
 *
 * A session is orphaned when:
 *   1. Its status is an active lifecycle status (not a terminal status).
 *   2. Its last heartbeat timestamp is older than ORPHAN_HEARTBEAT_THRESHOLD_MS.
 *
 * Returns false if lastHeartbeatAt is null (cannot determine state).
 *
 * @param status - Session lifecycle status (must be a valid SessionStatus)
 * @param lastHeartbeatAt - ISO 8601 timestamp or null
 * @param now - Current epoch ms; injected so tests can control the clock deterministically
 * @returns true if the session appears orphaned
 */
function isSessionOrphaned(
  status: SessionStatus,
  lastHeartbeatAt: string | null,
  now: number,
): boolean {
  if (!ACTIVE_STATUSES.has(status)) return false;
  if (!lastHeartbeatAt) return false;

  const staleDeltaMs = now - new Date(lastHeartbeatAt).getTime();
  return staleDeltaMs > ORPHAN_HEARTBEAT_THRESHOLD_MS;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Warning banner for sessions whose CLI has gone offline unexpectedly.
 *
 * Renders only when both conditions are met:
 *   - `status` is an active lifecycle status (starting/running/idle/paused)
 *   - `lastHeartbeatAt` is more than 90s in the past
 *
 * Two user actions:
 *   - **Dismiss**: Hides the banner locally. Does not call Supabase.
 *     Appropriate when the user knows what happened and just wants the
 *     banner out of the way.
 *   - **End Session**: Sets `status='stopped'` via Supabase. This is the
 *     same logical operation as `DELETE /api/v1/sessions/[id]` as
 *     described in the spec — the mobile app's data layer goes through
 *     Supabase directly rather than a REST layer.
 *
 * CONCERN (i18n): All strings are hardcoded in English. If the app adds
 * i18n in a future sprint, this component should be updated to use the
 * same translation system as the rest of the app.
 *
 * @param props - SessionOrphanedBannerProps
 * @returns React element or null
 *
 * @example
 * <SessionOrphanedBanner
 *   sessionId={session.id}
 *   status={session.status}
 *   lastHeartbeatAt={session.last_heartbeat_at}
 * />
 */
export function SessionOrphanedBanner({
  sessionId,
  status,
  lastHeartbeatAt,
  timeProvider = () => Date.now(),
}: SessionOrphanedBannerProps): React.ReactElement | null {
  /**
   * When true the user has dismissed the banner locally.
   * Resets on next mount (e.g., navigating away and back).
   */
  const [isDismissed, setIsDismissed] = useState(false);

  /** True while the "End Session" Supabase update is in flight. */
  const [isEnding, setIsEnding] = useState(false);

  /**
   * Error message from a failed "End Session" call. Cleared on retry
   * and on successful completion.
   */
  const [endError, setEndError] = useState<string | null>(null);

  // --- Orphan detection ---
  const orphaned = isSessionOrphaned(status, lastHeartbeatAt, timeProvider());

  // If not orphaned or dismissed, render nothing.
  if (!orphaned || isDismissed) return null;

  /**
   * Local dismiss: hides the banner without touching Supabase.
   *
   * WHY no server call: "Dismiss" is purely a UX affordance. The session
   * state in Supabase is unchanged. The user has acknowledged the banner
   * and chosen to leave the session record as-is.
   */
  const handleDismiss = () => {
    setIsDismissed(true);
  };

  /**
   * End Session: sets `status='stopped'` in Supabase, then hides the banner.
   *
   * WHY update status to 'stopped' rather than a soft-delete:
   *   The sessions table uses soft-delete (deleted_at timestamp). However,
   *   the appropriate user action here is to mark the session as cleanly
   *   stopped — not to erase it. The user may want to review the session
   *   history after the CLI was forcefully disconnected. 'stopped' matches
   *   the terminal status used by the CLI when it shuts down normally.
   *
   * SECURITY: SOC 2 CC6.1 — the update is scoped to a single row by id,
   * and Supabase RLS ensures only the session owner can update it.
   * GDPR Art. 7 — user-initiated termination of an active processing session.
   */
  const handleEndSession = async () => {
    setIsEnding(true);
    setEndError(null);

    try {
      const { error } = await supabase
        .from('sessions')
        .update({ status: 'stopped', ended_at: new Date().toISOString() })
        .eq('id', sessionId);

      if (error) {
        setEndError(`Failed to end session: ${error.message}`);
      } else {
        // Success — hide the banner. Supabase Realtime will propagate the
        // status change to any other listeners (e.g., the session list).
        setIsDismissed(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setEndError(`Failed to end session: ${msg}`);
    } finally {
      setIsEnding(false);
    }
  };

  return (
    <View
      testID="orphaned-banner"
      style={styles.container}
      // WHY 'none': React Native's AccessibilityRole enum does not include
      // 'status'. Using 'none' suppresses the default role announcement;
      // accessibilityLabel + accessibilityLiveRegion carry the message.
      accessibilityRole="none"
      accessibilityLiveRegion="polite"
      accessibilityLabel="Warning: This session's CLI was logged out. You can dismiss this warning or end the session."
    >
      {/* Warning icon dot — amber, matches ConnectionStateBadge palette */}
      <View style={styles.dotRow}>
        <View style={styles.dot} />
        <Text style={styles.title} numberOfLines={2}>
          {"This session's CLI was logged out. Tap to dismiss or end the session."}
        </Text>
      </View>

      {/* Error message (only rendered after a failed End Session call) */}
      {endError && (
        <Text style={styles.errorText} testID="end-session-error" numberOfLines={2}>
          {endError}
        </Text>
      )}

      {/* Action buttons */}
      <View style={styles.buttonRow}>
        {/* Dismiss — local state only */}
        <Pressable
          testID="dismiss-button"
          onPress={handleDismiss}
          style={styles.dismissButton}
          accessibilityRole="button"
          accessibilityLabel="Dismiss warning"
        >
          <Text style={styles.dismissLabel}>Dismiss</Text>
        </Pressable>

        {/* End Session — calls Supabase */}
        <Pressable
          testID="end-session-button"
          onPress={handleEndSession}
          disabled={isEnding}
          style={[styles.endButton, isEnding && styles.endButtonDisabled]}
          accessibilityRole="button"
          accessibilityLabel="End session"
          accessibilityState={{ disabled: isEnding }}
        >
          {isEnding ? (
            <ActivityIndicator
              testID="end-session-loading"
              size="small"
              color="#92400e"
            />
          ) : (
            <Text style={styles.endLabel}>End Session</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

/**
 * WHY StyleSheet.create and not NativeWind className here:
 *   NativeWind className processing requires the metro transformer. In the
 *   Jest test environment (node) NativeWind is fully mocked and className
 *   props are stripped. StyleSheet.create produces style objects that the
 *   react-native mock in jest.setup.js returns as-is, so style assertions
 *   in tests work correctly. ConnectionStateBadge uses the same pattern.
 */
const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginVertical: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.4)',
    gap: 8,
  },
  dotRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f59e0b',
    marginTop: 3,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 13,
    color: '#92400e',
    fontWeight: '500',
    lineHeight: 18,
  },
  errorText: {
    fontSize: 12,
    color: '#b45309',
    fontStyle: 'italic',
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 2,
  },
  dismissButton: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.5)',
  },
  dismissLabel: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '500',
  },
  endButton: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(245,158,11,0.25)',
    minWidth: 90,
    alignItems: 'center',
  },
  endButtonDisabled: {
    opacity: 0.55,
  },
  endLabel: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '600',
  },
});
