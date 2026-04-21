'use client';

/**
 * SessionConnectionBadge (Web)
 *
 * Chip + tooltip showing the daemon relay's connection state for a session.
 * Mirrors the mobile ConnectionStateBadge logic (parity rule) while using
 * Tailwind / plain HTML rather than React Native primitives.
 *
 * States:
 *   connected    — green dot + "Connected"
 *   reconnecting — amber dot + "Reconnecting…" (+ attempt when > 0)
 *   offline      — gray dot + "Offline" + optional "X min ago"
 *   unknown      — not rendered (returns null)
 *
 * WCAG 1.4.1: colour alone does not carry meaning — every state includes
 * a text label.  The tooltip adds `last seen` timestamp for screen readers.
 *
 * WHY attempt display cap: PR #114 allows unlimited retries so the attempt
 * counter can grow without bound.  We cap display at 99 and show "99+"
 * beyond that to prevent badge layout overflow.
 *
 * @module components/sessions/SessionConnectionBadge
 */

import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Connection status values — mirrors the mobile hook type.
 * Defined here rather than imported from shared so the web package has no
 * dependency on the mobile package.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline' | 'unknown';

/**
 * Props for {@link SessionConnectionBadge}.
 */
export interface SessionConnectionBadgeProps {
  /** Current connection status. */
  status: ConnectionStatus;
  /** Timestamp of last known daemon activity. */
  lastSeenAt: Date | string | null;
  /**
   * Reconnect attempt counter.  Only meaningful when status is 'reconnecting'.
   * Capped at 99 in display (shows "99+" beyond that).
   */
  attempt?: number;
  /** Optional extra CSS classes to apply to the outer chip element. */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum attempt number shown before truncating to "99+".
 * WHY: see module doc.
 */
const MAX_DISPLAYED_ATTEMPT = 99;

/** Tailwind colour classes per status. */
const STATUS_STYLES: Record<ConnectionStatus, { dot: string; chip: string; text: string }> = {
  connected: {
    dot: 'bg-green-500',
    chip: 'bg-green-500/10 border-green-500/20',
    text: 'text-green-400',
  },
  reconnecting: {
    dot: 'bg-amber-500',
    chip: 'bg-amber-500/10 border-amber-500/20',
    text: 'text-amber-400',
  },
  offline: {
    dot: 'bg-zinc-500',
    chip: 'bg-zinc-800/50 border-zinc-700/50',
    text: 'text-zinc-400',
  },
  unknown: {
    dot: 'bg-zinc-600',
    chip: 'bg-zinc-900 border-zinc-800',
    text: 'text-zinc-500',
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a date-like value as a relative age string.
 *
 * @param date - The timestamp to format (Date, ISO string, or null)
 * @returns Human-readable string like "2 min ago"
 */
function formatRelativeAge(date: Date | string | null): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr} hr ago`;
}

/**
 * Format a date for use in the tooltip title.
 *
 * @param date - Timestamp to format
 * @returns Locale-formatted string, or "Unknown"
 */
function formatAbsoluteDate(date: Date | string | null): string {
  if (!date) return 'Unknown';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format attempt count, capping at MAX_DISPLAYED_ATTEMPT.
 *
 * @param attempt - Raw attempt number
 * @returns Display string
 */
function formatAttempt(attempt: number): string {
  return attempt > MAX_DISPLAYED_ATTEMPT ? '99+' : String(attempt);
}

// ============================================================================
// Component
// ============================================================================

/**
 * Chip badge indicating the daemon relay's connection state.
 * Returns null when status is 'unknown' (no data yet).
 *
 * @param props - Badge configuration
 * @returns Chip element or null
 *
 * @example
 * <SessionConnectionBadge status="reconnecting" lastSeenAt={new Date()} attempt={3} />
 */
export function SessionConnectionBadge({
  status,
  lastSeenAt,
  attempt,
  className,
}: SessionConnectionBadgeProps) {
  if (status === 'unknown') return null;

  const styles = STATUS_STYLES[status];
  const relativeAge = formatRelativeAge(lastSeenAt);
  const absoluteDate = formatAbsoluteDate(lastSeenAt);

  /**
   * Build the label text.
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
      label = relativeAge ? `Offline - ${relativeAge}` : 'Offline';
      break;
    default:
      label = '--';
  }

  const tooltipTitle = `Last seen: ${absoluteDate}`;

  return (
    <span
      title={tooltipTitle}
      aria-label={`Connection status: ${label}. Last seen ${absoluteDate}.`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        styles.chip,
        styles.text,
        className,
      )}
    >
      {/* Colour dot — WCAG 1.4.1: text label carries meaning too. */}
      <span
        className={cn('h-1.5 w-1.5 rounded-full', styles.dot)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
