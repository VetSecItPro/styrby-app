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

    // WHY forward-scan in chronological order (CLI-FOLLOWUP #73 fix):
    //   The previous reverse-scan algorithm had an off-by-one at the START
    //   of the log. For `[close at T0, connected at T1]` (the simplest
    //   close+connected pair), reverse-scan visited `connected` first (no
    //   pending events yet → pushed as 'initial'), then visited `close`
    //   (no subsequent connected to pair with → marked as orphan-failed).
    //   Result: 2 events instead of 1 paired success.
    //
    //   Forward-scan is the natural shape for "pair X with the X-after-it":
    //   when we see a `connected`, look back at events we've already
    //   collected for an unpaired close and mark it succeeded. This produces
    //   exactly the right number of events with correct success flags
    //   regardless of where in the log the pair appears.
    //
    //   The original "stop early" optimization was premature — daemon log
    //   files are bounded by rotation, and the typical case is <100 lines.
    //   Scan all lines, return the last `limit` chronologically.
    const events: ReconnectEvent[] = [];

    for (const line of lines) {
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
          success: false, // pending — flipped to true when we see the matching `connected`
        });
      } else if (line.includes('Relay connected')) {
        // Pair with the LATEST unpaired close (search backward through
        // events). WHY latest-not-earliest: in chronological order, a
        // `connected` confirms the immediately-preceding `close`, not
        // some earlier disconnection that may have been followed by
        // another (still-failed) close before this success.
        let paired = false;
        for (let i = events.length - 1; i >= 0; i--) {
          if (!events[i].success) {
            events[i].success = true;
            paired = true;
            break;
          }
        }
        if (!paired) {
          // No preceding unpaired close — this is an initial connect
          // (process startup) or a redundant connected. Either way, it's
          // a successful event with no associated close.
          events.push({ timestamp, reason: 'initial', success: true });
        }
      }
    }

    // Most-recent first, capped at `limit`. After the forward-scan, `events`
    // is in chronological order (oldest → newest). slice(-limit) takes the
    // tail; .reverse() flips to newest-first for caller convenience.
    return events.slice(-limit).reverse();
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
