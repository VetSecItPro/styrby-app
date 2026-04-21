/**
 * `styrby status` command handler.
 *
 * Displays a formatted status table showing:
 *   - Daemon process state (running/stopped, PID, uptime)
 *   - Supabase Realtime connection state
 *   - Authentication status (user ID if authenticated)
 *   - Mobile pairing status
 *   - Active sessions count
 *
 * @module cli/handlers/status
 */

/**
 * Handle the `styrby status` command.
 *
 * Gathers information from multiple sources:
 *   1. Daemon status (PID file + status file via `getDaemonStatus`)
 *   2. IPC socket for live daemon data (if daemon is responsive)
 *   3. Persisted credentials for auth state
 *   4. Persisted data for pairing state
 *   5. Local session storage for active sessions
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

  // ── Hints ─────────────────────────────────────────────────────────────
  if (!daemonStatus.running) {
    console.log('');
    console.log(chalk.gray('  Tip: Start the daemon with: styrby start'));
  }

  console.log('');
}
