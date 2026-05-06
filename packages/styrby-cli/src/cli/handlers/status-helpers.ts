/**
 * Pure helper functions for the `styrby status` command.
 *
 * WHY a separate module: extracting these from status.ts makes them testable
 * (status.ts itself is heavy I/O — daemon IPC, persistence, log parsing —
 * which would require extensive mocking). These helpers have zero side
 * effects beyond reading a file path that the caller provides, so they can
 * be tested directly.
 *
 * @module cli/handlers/status-helpers
 */

import * as fs from 'node:fs';

/**
 * A single reconnect event entry parsed from the daemon log.
 * Written by the daemon whenever the relay transitions through a reconnect cycle.
 */
export interface ReconnectEvent {
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** Human-readable reason for the reconnect attempt. */
  reason: string;
  /** Whether the reconnect ultimately succeeded. */
  success: boolean;
}

/**
 * Read the last N reconnect events from the daemon log file.
 *
 * WHY parse the log for reconnect events rather than a separate file:
 *   Maintaining a separate reconnect-history JSON would require additional
 *   IPC round-trips and file writes inside the daemon hot path. The daemon
 *   log already contains structured entries for relay_closed, relay_connected,
 *   and relay_error events — we can derive reconnect history from those
 *   without touching daemon internals. Worst case: log is rotated or missing,
 *   in which case we return an empty array gracefully.
 *
 * @param logFile - Path to the daemon log file
 * @param limit - Maximum number of events to return (default 5)
 * @returns Array of reconnect events, most-recent first
 */
export function readReconnectHistory(logFile: string, limit = 5): ReconnectEvent[] {
  try {
    if (!fs.existsSync(logFile)) return [];
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    const events: ReconnectEvent[] = [];

    // WHY scan in reverse: we want the most-recent events first and we can
    // stop early once we have `limit` matching entries.
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      const line = lines[i];
      // Match lines like: [2026-04-21T12:34:56.789Z] [daemon] Relay closed, will reconnect ...
      //              or:  [2026-04-21T12:34:56.789Z] [daemon] Relay connected
      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (!tsMatch) continue;
      const timestamp = tsMatch[1];

      if (line.includes('Relay closed, will reconnect')) {
        // Extract reason if present: "Relay closed, will reconnect <reason>"
        const reasonMatch = line.match(/Relay closed, will reconnect\s+(.*)/);
        events.push({
          timestamp,
          reason: reasonMatch?.[1]?.trim() || 'unknown',
          success: false, // will be updated when we see the matching 'connected'
        });
      } else if (line.includes('Relay connected')) {
        // Mark the most recent pending (success=false) event as succeeded
        const pending = events.find((e) => !e.success);
        if (pending) {
          pending.success = true;
        } else {
          // Standalone connect (initial connect, not a reconnect)
          events.push({ timestamp, reason: 'initial', success: true });
        }
      }
    }

    return events.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Convert seconds into a human-readable uptime string.
 *
 * @param seconds - Total seconds of uptime
 * @returns Formatted string like "2h 15m" for hours, "5m 30s" for minutes,
 *          or "45s" for sub-minute durations.
 *
 * @example
 * formatUptime(45);    // "45s"
 * formatUptime(125);   // "2m 5s"
 * formatUptime(3661);  // "1h 1m"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Format a duration in milliseconds as a human-readable "time ago" string.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable relative time (e.g., "2m", "3h", "5d")
 *
 * @example
 * formatTimeAgo(45_000);          // "45s"
 * formatTimeAgo(120_000);          // "2m"
 * formatTimeAgo(3_600_000);        // "1h"
 * formatTimeAgo(86_400_000 * 3);   // "3d"
 */
export function formatTimeAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
