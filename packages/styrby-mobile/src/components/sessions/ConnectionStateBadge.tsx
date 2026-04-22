/**
 * ConnectionStateBadge
 *
 * Displays user-visible reconnect telemetry when the relay channel is
 * actively trying to re-establish a connection. Renders nothing when the
 * relay is connected, idle, or in a terminal error state — keeping the
 * session screen uncluttered during normal operation.
 *
 * WHY show attempt count + elapsed time:
 *   "Attempt 3 · 12s ago" tells the user:
 *     (a) the app is actively working to reconnect (not frozen)
 *     (b) how persistent the issue is (1 attempt = blip; 5 attempts = problem)
 *     (c) recency so they can judge whether to take action (e.g., toggle wifi)
 *   Without this, users see a static indicator with no sense of progress.
 *
 * WHY "isActiveRetry" gating (connecting + attempt > 0 + lastAttemptAt != null):
 *   - On initial connect (attempt === 0) we don't yet know if this will be a
 *     reconnect or a fresh connect. Showing "attempt 0" would confuse users.
 *   - Once attempt > 0 we know the relay has already lost and is retrying.
 *   - lastAttemptAt guard ensures we have a valid timestamp to display.
 *
 * @module components/sessions/ConnectionStateBadge
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { ConnectionState } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

export interface ConnectionStateBadgeProps {
  /** Current relay connection state. */
  connectionState: ConnectionState;

  /**
   * Number of reconnect attempts since the last successful connection.
   * Passed from useSessionConnectionState.
   */
  attempt: number;

  /**
   * ISO 8601 timestamp of the most recent reconnect attempt, or null
   * if no reconnect has started yet.
   */
  lastAttemptAt: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format the elapsed time since the last reconnect attempt in a short,
 * human-readable form. Returns values like "1s ago", "45s ago", "2m ago".
 *
 * WHY cap at minutes: Reconnect attempts that are hours old are irrelevant
 * telemetry — the badge only renders while the state is 'connecting' or
 * 'reconnecting', so the maximum practical elapsed time is short.
 *
 * @param isoTimestamp - ISO 8601 timestamp string
 * @returns Human-readable elapsed time string
 */
function formatElapsed(isoTimestamp: string): string {
  const deltaMs = Date.now() - new Date(isoTimestamp).getTime();
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  return `${Math.floor(deltaSec / 60)}m ago`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a small banner with reconnect telemetry.
 *
 * Returns null unless:
 *   - connectionState is 'connecting' or 'reconnecting'
 *   - attempt > 0 (at least one reconnect cycle has started)
 *   - lastAttemptAt is a valid ISO timestamp
 *
 * @param props - ConnectionStateBadgeProps
 * @returns React element or null
 *
 * @example
 * <ConnectionStateBadge
 *   connectionState={connectionState}
 *   attempt={attempt}
 *   lastAttemptAt={lastAttemptAt}
 * />
 */
export function ConnectionStateBadge({
  connectionState,
  attempt,
  lastAttemptAt,
}: ConnectionStateBadgeProps): React.ReactElement | null {
  const isActiveRetry =
    (connectionState === 'connecting' || connectionState === 'reconnecting') &&
    attempt > 0 &&
    lastAttemptAt !== null;

  if (!isActiveRetry) return null;

  const elapsed = formatElapsed(lastAttemptAt!);

  return (
    <View
      style={styles.container}
      // WHY 'none': React Native's AccessibilityRole enum does not include
      // 'status'. We use 'none' to suppress the default role announcement
      // and rely solely on accessibilityLabel + accessibilityLiveRegion for
      // screen reader output. VoiceOver/TalkBack will read the label when
      // the component mounts or its content changes.
      accessibilityRole="none"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Reconnecting — attempt ${attempt}, last try ${elapsed}`}
    >
      <View style={styles.dot} />
      <Text style={styles.label} numberOfLines={1}>
        {`Attempt ${attempt} · ${elapsed}`}
      </Text>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderRadius: 12,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f59e0b',
  },
  label: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '500',
  },
});
