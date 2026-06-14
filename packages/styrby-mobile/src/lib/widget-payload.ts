/**
 * Home-screen widget payload builder.
 *
 * The iOS widget (targets/widget/*.swift) can't run JavaScript; it reads a set
 * of string values from the shared App Group UserDefaults. This module is the
 * single place that turns a session row into that flat string map, so the wire
 * shape between the RN app and the Swift widget is defined + tested in one spot.
 *
 * Values are strings because App Group UserDefaults is read with
 * `.string(forKey:)` on the Swift side — keeping everything stringly-typed
 * avoids type-coercion mismatches across the language boundary.
 *
 * @module lib/widget-payload
 */

/** The subset of a session the widget needs. */
export interface WidgetSessionInput {
  /** Agent identifier, e.g. "claude". */
  agentType: string;
  /** Raw session lifecycle status. */
  status: string;
  /** Session title, if any. */
  title: string | null;
  /** Total cost in USD. */
  totalCostUsd: number;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
}

/** Flat string map written to the App Group for the Swift widget to read. */
export interface WidgetPayload {
  /** "true" when there is a session to show, "false" for the empty state. */
  hasSession: string;
  /** Agent identifier (empty string when no session). */
  agent: string;
  /** Human-readable status label (e.g. "Running"). */
  statusLabel: string;
  /** "true" when the session is in an active (non-terminal) state. */
  isActive: string;
  /** Display title (falls back to a placeholder). */
  title: string;
  /** Formatted cost, e.g. "$0.0400". */
  cost: string;
  /** ISO timestamp; the widget renders this as relative time itself. */
  updatedAt: string;
}

/** Status values that mean a session is still running (non-terminal). */
const ACTIVE_STATUSES = new Set(['starting', 'running', 'idle', 'paused']);

/** Human labels for known session statuses. */
const STATUS_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  paused: 'Paused',
  completed: 'Completed',
  error: 'Error',
};

/** The payload representing "no session to show". */
const EMPTY_PAYLOAD: WidgetPayload = {
  hasSession: 'false',
  agent: '',
  statusLabel: '',
  isActive: 'false',
  title: '',
  cost: '',
  updatedAt: '',
};

/**
 * Build the widget payload from the most-recent session (or null).
 *
 * @param session - The session to surface, or null for the empty state.
 * @returns A flat string map for the App Group.
 */
export function buildWidgetPayload(session: WidgetSessionInput | null): WidgetPayload {
  if (!session) return { ...EMPTY_PAYLOAD };

  const statusLabel = STATUS_LABELS[session.status] ?? session.status;

  return {
    hasSession: 'true',
    agent: session.agentType,
    statusLabel,
    isActive: ACTIVE_STATUSES.has(session.status) ? 'true' : 'false',
    title: session.title?.trim() ? session.title.trim() : 'Untitled session',
    cost: `$${(session.totalCostUsd || 0).toFixed(4)}`,
    updatedAt: session.updatedAt,
  };
}
