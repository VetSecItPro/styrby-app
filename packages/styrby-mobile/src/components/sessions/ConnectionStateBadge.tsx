/**
 * ConnectionStateBadge (Mobile)
 *
 * Compact pill / chip that renders the daemon's connection state for a session.
 * Used in two contexts:
 *   1. Chat header — full pill with label text + tap-to-expand.
 *   2. Session list row — small dot + optional "X min ago" text.
 *
 * Follows the BillingModelChip visual pattern: background tint + contrasting
 * text + icon so colour alone does not carry meaning (WCAG 1.4.1).
 *
 * States:
 *   connected    — green dot + "Connected"
 *   reconnecting — amber dot + "Reconnecting…" (or "Reconnecting (N)" when attempt > 0)
 *   offline      — gray dot + "Offline" + optional relative time
 *   unknown      — gray dot + "—"
 *
 * WHY attempt display cap: PR #114 allows unlimited retries so the attempt
 * counter can grow unboundedly.  We cap displayed attempt count at 99 to
 * prevent badge overflow.  Once the counter exceeds 99 we show "99+" to
 * signal persistent failure without dominating the UI.
 *
 * @module components/sessions/ConnectionStateBadge
 */

import { View, Text, Pressable } from 'react-native';
import type { ConnectionStatus } from '../../hooks/useSessionConnectionState';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum attempt number shown in the badge before truncating to "99+".
 * WHY: PR #114 allows unlimited retries; an unbounded counter would break
 * the badge layout and become meaningless noise beyond this threshold.
 */
const MAX_DISPLAYED_ATTEMPT = 99;

/** Dot + text colour per connection status. */
const STATUS_COLORS: Record<ConnectionStatus, { dot: string; text: string; bg: string }> = {
  connected:    { dot: '#22c55e', text: '#4ade80', bg: '#14532d' }, // green
  reconnecting: { dot: '#f59e0b', text: '#fbbf24', bg: '#78350f' }, // amber
  offline:      { dot: '#71717a', text: '#a1a1aa', bg: '#27272a' }, // zinc
  unknown:      { dot: '#52525b', text: '#71717a', bg: '#18181b' }, // darker zinc
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a Date as a relative "X min ago" / "X hr ago" / "just now" string.
 *
 * @param date - The timestamp to format
 * @returns Human-readable relative time string
 */
function formatRelativeAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr} hr ago`;
}

/**
 * Format the reconnect attempt for display.
 * Caps at MAX_DISPLAYED_ATTEMPT to prevent layout overflow.
 *
 * @param attempt - Raw attempt number from the relay
 * @returns Formatted string like "3" or "99+"
 */
function formatAttempt(attempt: number): string {
  return attempt > MAX_DISPLAYED_ATTEMPT ? '99+' : String(attempt);
}

// ============================================================================
// Full pill (chat header)
// ============================================================================

/**
 * Props for {@link ConnectionStatePill}.
 */
export interface ConnectionStatePillProps {
  /** Current connection status. */
  status: ConnectionStatus;
  /** Timestamp of last known daemon activity. */
  lastSeenAt: Date | null;
  /** Reconnect attempt counter (present when status === 'reconnecting'). */
  attempt?: number;
  /**
   * Optional callback fired when the user taps the pill to see more detail.
   * If omitted the pill is not interactive.
   */
  onPress?: () => void;
}

/**
 * Full pill badge for the chat header.
 * Tappable when `onPress` is provided — expands to show last-seen detail.
 *
 * @param props - ConnectionStatePillProps
 * @returns Pressable or View badge element
 *
 * @example
 * <ConnectionStatePill
 *   status="reconnecting"
 *   lastSeenAt={new Date()}
 *   attempt={3}
 *   onPress={() => setDetailVisible(true)}
 * />
 */
export function ConnectionStatePill({
  status,
  lastSeenAt,
  attempt,
  onPress,
}: ConnectionStatePillProps) {
  const colors = STATUS_COLORS[status];

  /**
   * Build the label text for the pill.
   * WHY attempt display cap: see module doc.
   */
  let label: string;
  switch (status) {
    case 'connected':
      label = 'Connected';
      break;
    case 'reconnecting':
      label =
        attempt !== undefined && attempt > 0
          ? `Reconnecting (${formatAttempt(attempt)})`
          : 'Reconnecting…';
      break;
    case 'offline':
      label = 'Offline';
      break;
    default:
      label = '--';
  }

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.bg,
        borderRadius: 12,
        paddingHorizontal: 8,
        paddingVertical: 3,
        gap: 5,
      }}
      accessibilityLabel={`Connection status: ${label}${lastSeenAt && status === 'offline' ? `, last seen ${formatRelativeAge(lastSeenAt)}` : ''}`}
    >
      {/* Colour dot — visual indicator.  WCAG 1.4.1: text label carries meaning too. */}
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: colors.dot,
        }}
        aria-hidden
      />
      <Text
        style={{
          color: colors.text,
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityHint="Show connection details"
      >
        {content}
      </Pressable>
    );
  }

  return content;
}

// ============================================================================
// Row dot (sessions list)
// ============================================================================

/**
 * Props for {@link ConnectionStateDot}.
 */
export interface ConnectionStateDotProps {
  /** Current connection status. */
  status: ConnectionStatus;
  /** Timestamp of last known daemon activity (shown for offline sessions). */
  lastSeenAt: Date | null;
}

/**
 * Small colour-coded dot + optional "X min ago" text for the session list row.
 *
 * Colour alone does not carry meaning here: the parent SessionCard already
 * shows a text status badge.  This dot is additive glance UX, not the sole
 * indicator.
 *
 * @param props - ConnectionStateDotProps
 * @returns Inline row element
 *
 * @example
 * <ConnectionStateDot status="offline" lastSeenAt={lastSeen} />
 */
export function ConnectionStateDot({ status, lastSeenAt }: ConnectionStateDotProps) {
  if (status === 'unknown') return null;

  const colors = STATUS_COLORS[status];
  const relativeAge = lastSeenAt && status === 'offline' ? formatRelativeAge(lastSeenAt) : null;

  const accessibilityLabel = [
    `Connection: ${status}`,
    relativeAge ? relativeAge : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}
      accessibilityLabel={accessibilityLabel}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: colors.dot,
        }}
        aria-hidden
      />
      {relativeAge && (
        <Text
          style={{
            color: '#71717a',
            fontSize: 10,
          }}
          numberOfLines={1}
        >
          {relativeAge}
        </Text>
      )}
    </View>
  );
}
