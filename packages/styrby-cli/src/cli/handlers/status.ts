/**
 * `styrby status` command handler.
 *
 * Displays a formatted status table showing:
 *   - Daemon process state (running/stopped, PID, uptime)
 *   - Supabase Realtime connection state
 *   - Authentication status (user ID if authenticated)
 *   - Mobile pairing status
 *   - Active sessions count
 *   - Reconnect history (last 5 reconnect events with timestamp + outcome)
 *
 * @module cli/handlers/status
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Reconnect History Types
// ============================================================================

/**
 * A single reconnect event entry parsed from the daemon log.
 * Written by the daemon whenever the relay transitions through a reconnect cycle.
 */
interface ReconnectEvent {
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** Human-readable reason for the reconnect attempt. */
  reason: string;
  /** Whether the reconnect ultimately succeeded. */
  success: boolean;
}

// ============================================================================
// Reconnect History Reader
// ============================================================================

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
function readReconnectHistory(logFile: string, limit = 5): ReconnectEvent[] {
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

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle the `styrby status` command.
 *
 * Gathers information from multiple sources:
 *   1. Daemon status (PID file + status file via `getDaemonStatus`)
 *   2. IPC socket for live daemon data (if daemon is responsive)
 *   3. Persisted credentials for auth state
 *   4. Persisted data for pairing state
 *   5. Local session storage for active sessions
 *   6. Daemon log file for reconnect history
 */
export async function handleStatus(): Promise<void> {
  const chalk = (await import('chalk')).default;
  const { getDaemonStatus } = await import('@/daemon/run');
  const { canConnectToDaemon, getDaemonStatusViaIpc, listConnectedDevices } = await import('@/daemon/controlClient');
  const { loadPersistedData, listSessions } = await import('@/persistence');

  // ── Gather data from all sources in parallel ──────────────────────────
  // WHY: We fetch from multiple independent sources. Doing it in parallel
  // saves time (~3s IPC timeout if daemon is dead) and avoids sequential waits.
  const [fileStatus, ipcReachable, persistedData, storedSessions] = await Promise.all([
    Promise.resolve(getDaemonStatus()),
    canConnectToDaemon(),
    Promise.resolve(loadPersistedData()),
    Promise.resolve(listSessions()),
  ]);

  // If IPC is reachable, prefer its live data over the status file
  let daemonStatus = fileStatus;
  let connectedDevices: unknown[] = [];

  if (ipcReachable) {
    const [ipcStatus, devices] = await Promise.all([
      getDaemonStatusViaIpc(),
      listConnectedDevices(),
    ]);
    if (ipcStatus.running) {
      daemonStatus = ipcStatus;
    }
    connectedDevices = devices;
  }

  // ── Format uptime ─────────────────────────────────────────────────────
  /**
   * Convert seconds into a human-readable uptime string.
   *
   * @param seconds - Total seconds of uptime
   * @returns Formatted string like "2h 15m" or "45s"
   */
  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  /**
   * Format a duration in milliseconds as a human-readable "time ago" string.
   *
   * @param ms - Duration in milliseconds
   * @returns Human-readable relative time (e.g., "2m", "3h", "5d")
   */
  const formatTimeAgo = (ms: number): string => {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  };

  // ── Build status lines ────────────────────────────────────────────────
  const SEPARATOR = chalk.gray('\u2500'.repeat(45));
  const LABEL_WIDTH = 14;

  /**
   * Format a status row with consistent label alignment.
   *
   * @param label - Left-side label text
   * @param value - Right-side value text (already chalk-colored)
   * @returns Formatted row string
   */
  const row = (label: string, value: string): string => {
    return `  ${chalk.bold(label.padEnd(LABEL_WIDTH))} ${value}`;
  };

  console.log('');
  console.log(chalk.bold.cyan('  Styrby Status'));
  console.log(`  ${SEPARATOR}`);

  // ── Daemon ────────────────────────────────────────────────────────────
  if (daemonStatus.running) {
    const pidStr = daemonStatus.pid ? ` (PID ${daemonStatus.pid})` : '';
    const uptimeStr = daemonStatus.uptimeSeconds
      ? chalk.gray(` | uptime ${formatUptime(daemonStatus.uptimeSeconds)}`)
      : '';
    console.log(row('Daemon:', chalk.green('Running') + chalk.gray(pidStr) + uptimeStr));
  } else {
    const hint = daemonStatus.errorMessage
      ? chalk.gray(` (${daemonStatus.errorMessage})`)
      : '';
    console.log(row('Daemon:', chalk.red('Stopped') + hint));
  }

  // ── Connection ────────────────────────────────────────────────────────
  if (daemonStatus.running) {
    const stateColors: Record<string, (s: string) => string> = {
      connected: chalk.green,
      connecting: chalk.yellow,
      reconnecting: chalk.yellow,
      disconnected: chalk.red,
      error: chalk.red,
    };
    const state = daemonStatus.connectionState || 'unknown';
    const colorFn = stateColors[state] || chalk.gray;
    const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
    const errorHint = state === 'error' && daemonStatus.errorMessage
      ? chalk.gray(` (${daemonStatus.errorMessage})`)
      : '';
    console.log(row('Connection:', colorFn(stateLabel) + errorHint));
  } else {
    console.log(row('Connection:', chalk.gray('N/A (daemon not running)')));
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  if (persistedData?.userId && persistedData?.accessToken) {
    // WHY: We don't store the email in persisted data currently, so we show
    // the user ID (truncated) as a proxy. A future enhancement could decode
    // the JWT to extract the email claim.
    const userDisplay = persistedData.userId.length > 12
      ? `${persistedData.userId.substring(0, 12)}...`
      : persistedData.userId;
    const authDate = persistedData.authenticatedAt
      ? chalk.gray(` (since ${new Date(persistedData.authenticatedAt).toLocaleDateString()})`)
      : '';
    console.log(row('Auth:', chalk.green('Authenticated') + chalk.gray(` [${userDisplay}]`) + authDate));
  } else {
    console.log(row('Auth:', chalk.red('Not authenticated') + chalk.gray(' (run: styrby onboard)')));
  }

  // ── Mobile Pairing ────────────────────────────────────────────────────
  if (persistedData?.pairedAt) {
    const pairedDate = new Date(persistedData.pairedAt);
    const timeSincePair = Date.now() - pairedDate.getTime();
    const timeAgo = formatTimeAgo(timeSincePair);

    // Check if mobile is currently connected via relay
    const mobileOnline = connectedDevices.some((d) => {
      const device = d as { device_type?: string };
      return device.device_type === 'mobile';
    });

    if (mobileOnline) {
      console.log(row('Mobile:', chalk.green('Online') + chalk.gray(` (paired ${timeAgo} ago)`)));
    } else {
      console.log(row('Mobile:', chalk.yellow('Paired') + chalk.gray(` (last paired ${timeAgo} ago, currently offline)`)));
    }
  } else {
    console.log(row('Mobile:', chalk.red('Not paired') + chalk.gray(' (run: styrby pair)')));
  }

  // ── Sessions ──────────────────────────────────────────────────────────
  const activeSessions = storedSessions.filter(s => s.status === 'active' || s.status === 'running');
  if (activeSessions.length > 0) {
    const sessionDescs = activeSessions.map(s => {
      const project = s.projectPath.split('/').pop() || s.projectPath;
      return `${s.agentType}/${project}`;
    });
    const sessionStr = `${activeSessions.length} active (${sessionDescs.join(', ')})`;
    console.log(row('Sessions:', chalk.green(sessionStr)));
  } else if (daemonStatus.activeSessions && daemonStatus.activeSessions > 0) {
    console.log(row('Sessions:', chalk.green(`${daemonStatus.activeSessions} active`)));
  } else {
    console.log(row('Sessions:', chalk.gray('None')));
  }

  console.log(`  ${SEPARATOR}`);

  // ── Reconnect History ─────────────────────────────────────────────────
  // WHY: Showing the last 5 reconnect events lets founders see patterns
  // (e.g., repeated network drops) without tailing the raw daemon.log.
  const logFile = path.join(os.homedir(), '.styrby', 'daemon.log');
  const reconnectEvents = readReconnectHistory(logFile, 5);
  if (reconnectEvents.length > 0) {
    console.log('');
    console.log(chalk.bold.gray('  Reconnect history (last 5)'));
    for (const evt of reconnectEvents) {
      const ts = new Date(evt.timestamp);
      const timeAgoMs = Date.now() - ts.getTime();
      const timeAgoStr = formatTimeAgo(timeAgoMs);
      const outcomeColor = evt.success ? chalk.green : chalk.red;
      const outcome = evt.success ? 'success' : 'failed';
      const reasonStr = evt.reason !== 'initial' ? chalk.gray(` (${evt.reason})`) : '';
      console.log(`    ${chalk.gray(timeAgoStr + ' ago')}  ${outcomeColor(outcome)}${reasonStr}`);
    }
  }

  // ── Hints ─────────────────────────────────────────────────────────────
  if (!daemonStatus.running) {
    console.log('');
    console.log(chalk.gray('  Tip: Start the daemon with: styrby start'));
  }

  console.log('');
}
