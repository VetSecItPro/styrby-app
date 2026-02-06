#!/usr/bin/env node
/**
 * Styrby CLI
 *
 * Mobile remote control for AI coding agents.
 * Connects Claude Code, Codex, and Gemini CLI to the Styrby mobile app.
 *
 * @module styrby-cli
 *
 * @example
 * # Complete setup wizard
 * styrby onboard
 *
 * # Start a session with Claude Code
 * styrby start --agent claude
 *
 * # Show status
 * styrby status
 */

import { logger } from '@/ui/logger';
import { isAuthenticated } from '@/configuration';

// Re-export core types for library usage
export type {
  AgentBackend,
  AgentId,
  AgentTransport,
  AgentBackendConfig,
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  StartSessionResult,
} from './agent/core/AgentBackend';

export { AgentRegistry } from './agent/core/AgentRegistry';

/**
 * CLI version
 */
export const VERSION = '0.1.0';

/**
 * Main CLI entry point.
 *
 * Parses command line arguments and dispatches to appropriate handlers.
 * If no command is given, launches interactive mode.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Interactive mode if no command given
  if (!command || command === undefined) {
    const { runInteractive } = await import('@/commands/interactive');
    await runInteractive();
    return;
  }

  // Only show version header for non-interactive commands
  logger.info(`Styrby CLI v${VERSION}`);

  switch (command) {
    case 'onboard':
      await handleOnboard(args.slice(1));
      break;

    case 'install':
      await handleInstall(args.slice(1));
      break;

    case 'auth':
      await handleAuth();
      break;

    case 'pair':
      await handlePair();
      break;

    case 'start':
      await handleStart(args.slice(1));
      break;

    case 'stop':
      await handleStop(args.slice(1));
      break;

    case 'status':
      await handleStatus();
      break;

    case 'logs':
      await handleLogs(args.slice(1));
      break;

    case 'upgrade':
    case 'update':
      await handleUpgrade(args.slice(1));
      break;

    case 'daemon':
      await handleDaemonCommand(args.slice(1));
      break;

    case 'doctor':
      await handleDoctor();
      break;

    case 'costs':
      await handleCosts(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * Handle the 'stop' command.
 * Stops the running daemon process.
 *
 * @param args - Command arguments
 */
async function handleStop(args: string[]): Promise<void> {
  const { handleStop: stop } = await import('@/commands/stop');
  await stop(args);
}

/**
 * Handle the 'logs' command.
 * View daemon logs with optional following.
 *
 * @param args - Command arguments (--follow, --lines N)
 */
async function handleLogs(args: string[]): Promise<void> {
  const { handleLogs: logs } = await import('@/commands/logs');
  await logs(args);
}

/**
 * Handle the 'upgrade' command.
 * Check for and install CLI updates from npm.
 *
 * @param args - Command arguments (--check to only check)
 */
async function handleUpgrade(args: string[]): Promise<void> {
  const { handleUpgrade: upgrade } = await import('@/commands/upgrade');
  await upgrade(args);
}

/**
 * Handle the 'daemon' command.
 * Manage daemon auto-start on boot (install/uninstall).
 *
 * @param args - Command arguments (install, uninstall, status)
 */
async function handleDaemonCommand(args: string[]): Promise<void> {
  const { handleDaemon } = await import('@/commands/daemon');
  await handleDaemon(args);
}

/**
 * Handle the 'onboard' command.
 * Complete setup wizard: auth + machine registration + mobile pairing.
 *
 * @param args - Command arguments
 */
async function handleOnboard(args: string[]): Promise<void> {
  const { runOnboard, parseOnboardArgs } = await import('@/commands/onboard');
  const options = parseOnboardArgs(args);
  const result = await runOnboard(options);

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the 'install' command.
 * Install AI coding agents (Claude Code, Codex, Gemini CLI).
 *
 * @param args - Command arguments
 */
async function handleInstall(args: string[]): Promise<void> {
  const { handleInstallCommand } = await import('@/commands/install-agent');
  await handleInstallCommand(args);
}

/**
 * Handle the 'auth' command.
 * Authenticates with Styrby (without mobile pairing).
 */
async function handleAuth(): Promise<void> {
  const { runOnboard } = await import('@/commands/onboard');

  // Run onboard with pairing skipped
  const result = await runOnboard({ skipPairing: true });

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the 'pair' command.
 * Generates a QR code for mobile app pairing and waits for connection.
 */
async function handlePair(): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  const os = await import('os');
  const crypto = await import('crypto');
  const { createClient } = await import('@supabase/supabase-js');
  const chalk = (await import('chalk')).default;

  // Import pairing utilities from shared package
  const { encodePairingUrl, generatePairingToken, PAIRING_EXPIRY_MINUTES, createRelayClient } = await import('styrby-shared');

  // Load stored credentials
  const { loadPersistedData, savePersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    logger.error('Not authenticated. Please run "styrby onboard" first.');
    process.exit(1);
  }

  // Generate pairing payload
  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();
  const token = generatePairingToken();

  const { config } = await import('@/env');
  const supabaseUrl = config.supabaseUrl;
  const supabaseAnonKey = config.supabaseAnonKey;

  const payload = {
    version: 1 as const,
    token,
    userId: data.userId,
    machineId,
    deviceName,
    supabaseUrl,
    expiresAt: new Date(Date.now() + PAIRING_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };

  const pairingUrl = encodePairingUrl(payload);

  // Display QR code
  console.log('\n');
  logger.info('Scan this QR code with the Styrby mobile app:\n');

  qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log('\n');
  console.log(`Machine: ${deviceName}`);
  console.log(`Expires: ${PAIRING_EXPIRY_MINUTES} minutes`);
  console.log('\nWaiting for mobile app to connect...');
  console.log('(Press Ctrl+C to cancel)\n');

  // Create authenticated Supabase client
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // Create relay client and wait for mobile presence
  const relay = createRelayClient({
    supabase,
    userId: data.userId,
    deviceId: machineId,
    deviceType: 'cli',
    deviceName,
    platform: process.platform,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  try {
    await relay.connect();

    // Wait for mobile device to join (5 minute timeout)
    const timeoutMs = PAIRING_EXPIRY_MINUTES * 60 * 1000;
    const paired = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      // Check if mobile is already connected
      if (relay.isDeviceTypeOnline('mobile')) {
        clearTimeout(timeout);
        resolve(true);
        return;
      }

      // Wait for mobile to join
      const onJoin = (presence: { device_type: string }) => {
        if (presence.device_type === 'mobile') {
          clearTimeout(timeout);
          relay.off('presence_join', onJoin);
          resolve(true);
        }
      };

      relay.on('presence_join', onJoin);

      // Handle Ctrl+C gracefully
      const onInterrupt = () => {
        clearTimeout(timeout);
        relay.off('presence_join', onJoin);
        process.off('SIGINT', onInterrupt);
        resolve(false);
      };

      process.on('SIGINT', onInterrupt);
    });

    if (paired) {
      // Send test ping
      await relay.sendCommand('ping');
      console.log(chalk.green('\nSUCCESS! Mobile paired successfully.\n'));

      // Save pairing timestamp
      savePersistedData({
        pairedAt: new Date().toISOString(),
      });
    } else {
      console.log(chalk.yellow('\nPairing timed out or cancelled.\n'));
      console.log('You can try again with: styrby pair\n');
    }
  } catch (error) {
    logger.debug('Pairing error', { error });
    console.log(chalk.red('\nPairing failed. Please try again.\n'));
  } finally {
    await relay.disconnect();
  }
}

/**
 * Handle the 'start' command.
 *
 * Creates a full agent session that bridges the AI coding agent (Claude, Codex,
 * Gemini, etc.) to the Styrby mobile app via Supabase Realtime.
 *
 * Flow:
 * 1. Load persisted credentials and verify authentication
 * 2. Create an authenticated Supabase client with the stored access token
 * 3. Connect the StyrbyApi relay to the user's Realtime channel
 * 4. Look up the requested agent in the AgentRegistry and create a backend
 * 5. Start a managed session (ApiSessionManager handles agent <-> relay bridging)
 * 6. Wait for the session to end (user presses Ctrl+C, mobile sends end_session, or agent exits)
 * 7. Clean up: dispose agent, disconnect relay, update session status
 *
 * @param args - Command arguments (--agent, --project, etc.)
 */
async function handleStart(args: string[]): Promise<void> {
  const chalk = (await import('chalk')).default;
  const os = await import('os');
  const path = await import('path');
  const { createClient } = await import('@supabase/supabase-js');

  // ── Parse CLI arguments ──────────────────────────────────────────────
  let agentType = 'claude';
  let projectPath = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' || args[i] === '-a') {
      agentType = args[++i] || 'claude';
    } else if (args[i] === '--project' || args[i] === '-p') {
      projectPath = args[++i] || process.cwd();
    }
  }

  // Resolve relative paths to absolute so the agent runs in the right directory
  projectPath = path.resolve(projectPath);

  logger.info(`Starting ${agentType} session in ${projectPath}`);

  // ── 1. Check authentication ──────────────────────────────────────────
  const { loadPersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    console.log(chalk.red('\nNot authenticated.'));
    console.log('Run ' + chalk.cyan('styrby onboard') + ' to set up authentication.\n');
    process.exit(1);
  }

  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();

  logger.debug('Credentials loaded', {
    userId: data.userId.slice(0, 8) + '...',
    machineId: machineId.slice(0, 8) + '...',
  });

  // ── 2. Create authenticated Supabase client ──────────────────────────
  const { config: envConfig } = await import('@/env');

  if (!envConfig.supabaseAnonKey) {
    console.log(chalk.red('\nSupabase anonymous key not configured.'));
    console.log('Set the SUPABASE_ANON_KEY environment variable.\n');
    process.exit(1);
  }

  const supabase = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // ── 3. Connect to Supabase Realtime relay ────────────────────────────
  const { StyrbyApi } = await import('@/api/api');
  const apiClient = new StyrbyApi();

  apiClient.configure({
    supabase,
    userId: data.userId,
    machineId,
    machineName: deviceName,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  console.log(chalk.gray('Connecting to relay...'));

  try {
    await apiClient.connect();
  } catch (error) {
    console.log(chalk.red('\nFailed to connect to the relay.'));
    console.log('Check your internet connection and try again.');
    if (error instanceof Error) {
      logger.debug('Relay connection error', { message: error.message });
    }
    process.exit(1);
  }

  console.log(chalk.green('Connected to relay.'));

  // Check if mobile is online (informational, not blocking)
  if (apiClient.isMobileOnline()) {
    console.log(chalk.green('Mobile app is online.'));
  } else {
    console.log(chalk.yellow('Mobile app is not yet connected. Open the Styrby app to control this session.'));
  }

  // ── 4. Initialize agent registry and create backend ──────────────────
  // WHY: We initialize agents here (not at module load) because the agent
  // factories have heavy imports (@agentclientprotocol/sdk, transport handlers)
  // that would slow down CLI startup for every command, not just 'start'.
  const { initializeAgents, agentRegistry } = await import('@/agent/index');
  initializeAgents();

  // Validate the requested agent is available
  const validAgentId = agentType as import('@/agent/core/AgentBackend').AgentId;
  if (!agentRegistry.has(validAgentId)) {
    const available = agentRegistry.list().join(', ') || 'none registered';
    console.log(chalk.red(`\nAgent "${agentType}" is not available.`));
    console.log(`Registered agents: ${available}`);
    console.log(`\nInstall with: ${chalk.cyan(`styrby install ${agentType}`)}\n`);
    await apiClient.disconnect();
    process.exit(1);
  }

  console.log(chalk.gray(`Creating ${agentType} backend...`));

  const agent = agentRegistry.create(validAgentId, {
    cwd: projectPath,
  });

  // ── 5. Start managed session (agent <-> relay bridge) ────────────────
  const { ApiSessionManager } = await import('@/api/apiSession');
  const sessionManager = new ApiSessionManager();

  let activeSession: import('@/api/apiSession').ActiveSession;

  try {
    activeSession = await sessionManager.startManagedSession({
      supabase,
      api: apiClient,
      agent,
      agentType: agentType as import('styrby-shared').AgentType,
      userId: data.userId,
      machineId,
      projectPath,
    });
  } catch (error) {
    console.log(chalk.red('\nFailed to start agent session.'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    await apiClient.disconnect();
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold(`Session started.`));
  console.log(chalk.gray(`  Session:  ${activeSession.sessionId.slice(0, 8)}...`));
  console.log(chalk.gray(`  Agent:    ${agentType}`));
  console.log(chalk.gray(`  Project:  ${projectPath}`));
  console.log('');
  console.log('Send messages from the Styrby mobile app.');
  console.log('Press ' + chalk.cyan('Ctrl+C') + ' to end the session.\n');

  // Save session locally for 'styrby status' to find
  const { saveSession } = await import('@/persistence');
  saveSession({
    sessionId: activeSession.sessionId,
    agentType: agentType as 'claude' | 'codex' | 'gemini',
    projectPath,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
  });

  // ── 6. Wait for session to end ───────────────────────────────────────

  // WHY: We use a Promise that resolves when:
  // (a) User presses Ctrl+C
  // (b) Mobile sends an 'end_session' command
  // (c) The process receives SIGTERM (e.g., from a service manager)
  // This keeps the CLI alive while the relay bridge handles all communication.
  const sessionDone = new Promise<string>((resolve) => {
    // Handle Ctrl+C (SIGINT)
    const onSigint = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve('user_interrupt');
    };

    // Handle SIGTERM (graceful shutdown)
    const onSigterm = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve('sigterm');
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    // Listen for 'end_session' command from mobile
    sessionManager.onSessionUpdate(activeSession.sessionId, (update) => {
      if (update.type === 'end_session_requested') {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        resolve('mobile_end_session');
      }
    });
  });

  const endReason = await sessionDone;
  logger.debug('Session ending', { reason: endReason });

  // ── 7. Clean up ──────────────────────────────────────────────────────
  console.log(chalk.gray('\nEnding session...'));

  await activeSession.stop();
  await apiClient.disconnect();

  // Update local session record
  saveSession({
    sessionId: activeSession.sessionId,
    agentType: agentType as 'claude' | 'codex' | 'gemini',
    projectPath,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'stopped',
  });

  const reasonLabels: Record<string, string> = {
    user_interrupt: 'User pressed Ctrl+C',
    sigterm: 'Process terminated',
    mobile_end_session: 'Ended from mobile app',
  };

  console.log(chalk.green('\nSession ended.'));
  console.log(chalk.gray(`Reason: ${reasonLabels[endReason] || endReason}\n`));
}

/**
 * Handle the 'status' command.
 *
 * Displays a formatted status table showing:
 * - Daemon process state (running/stopped, PID, uptime)
 * - Supabase Realtime connection state
 * - Authentication status (user ID if authenticated)
 * - Mobile pairing status
 * - Active sessions count
 *
 * Gathers information from multiple sources:
 * 1. Daemon status (PID file + status file via getDaemonStatus)
 * 2. IPC socket for live daemon data (if daemon is responsive)
 * 3. Persisted credentials for auth state
 * 4. Persisted data for pairing state
 * 5. Local session storage for active sessions
 */
async function handleStatus(): Promise<void> {
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

/**
 * Handle the 'doctor' command.
 * Runs diagnostic checks.
 */
async function handleDoctor(): Promise<void> {
  const { runDoctor } = await import('@/ui/doctor');
  const success = await runDoctor();
  process.exit(success ? 0 : 1);
}

/**
 * Handle the 'costs' command.
 * Shows token usage and cost breakdown from Claude Code JSONL files.
 *
 * @param args - Command arguments (--today, --month, --all)
 */
async function handleCosts(args: string[]): Promise<void> {
  const { aggregateCosts, getTodayCosts, getMonthCosts, MODEL_PRICING } = await import('@/costs/index');

  let summary;
  let periodLabel = 'All time';

  if (args.includes('--today') || args.includes('-t')) {
    summary = await getTodayCosts();
    periodLabel = 'Today';
  } else if (args.includes('--month') || args.includes('-m')) {
    summary = await getMonthCosts();
    periodLabel = 'This month';
  } else {
    summary = await aggregateCosts();
  }

  // Format numbers
  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  const formatCost = (n: number): string => `$${n.toFixed(4)}`;

  // Print summary
  console.log(`\n📊 Cost Summary (${periodLabel})`);
  console.log('─'.repeat(50));

  if (summary.sessionCount === 0) {
    console.log('\nNo session data found.');
    console.log('Session files are stored in ~/.claude/projects/');
    return;
  }

  console.log(`\n  Sessions:       ${summary.sessionCount}`);
  console.log(`  Input tokens:   ${formatTokens(summary.totalInputTokens)}`);
  console.log(`  Output tokens:  ${formatTokens(summary.totalOutputTokens)}`);
  if (summary.totalCacheReadTokens > 0) {
    console.log(`  Cache read:     ${formatTokens(summary.totalCacheReadTokens)}`);
  }
  if (summary.totalCacheWriteTokens > 0) {
    console.log(`  Cache write:    ${formatTokens(summary.totalCacheWriteTokens)}`);
  }
  console.log(`\n  Total cost:     ${formatCost(summary.totalCostUsd)}`);

  // Print by model breakdown
  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    console.log('\n📈 By Model');
    console.log('─'.repeat(50));

    for (const [model, modelData] of models) {
      const data = modelData as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
      };
      const pricing = MODEL_PRICING[model];
      const priceInfo = pricing
        ? `($${pricing.input}/$${pricing.output} per 1M)`
        : '(unknown pricing)';

      console.log(`\n  ${model}`);
      console.log(`    ${priceInfo}`);
      console.log(`    Input: ${formatTokens(data.inputTokens)} | Output: ${formatTokens(data.outputTokens)}`);
      console.log(`    Cost: ${formatCost(data.costUsd)}`);
    }
  }

  // Print date range
  if (summary.firstTimestamp && summary.lastTimestamp) {
    console.log('\n📅 Date Range');
    console.log('─'.repeat(50));
    console.log(`  From: ${summary.firstTimestamp.toLocaleString()}`);
    console.log(`  To:   ${summary.lastTimestamp.toLocaleString()}`);
  }

  console.log('\n');
}

/**
 * Print CLI help.
 */
function printHelp(): void {
  console.log(`
styrby v${VERSION}

Usage: styrby [command] [options]

Mobile relay for AI coding agents. Control Claude Code, Codex, Gemini CLI,
and OpenCode from your phone. Code stays local — only I/O is relayed.

Commands:

  Setup
    onboard                 First-time setup (auth + machine registration + pairing)
    auth                    Authenticate only (skip pairing)
    pair                    Generate QR code for mobile app pairing
    install <agent>         Install an AI agent (claude, codex, gemini, opencode)

  Session
    start                   Start a coding session
    stop                    Stop running daemon
    status                  Show connection and session status
    logs                    View daemon logs (--follow, --lines N)
    costs                   Display token usage and cost breakdown

  Daemon
    daemon install          Install daemon to start automatically on boot
    daemon uninstall        Remove daemon from auto-start
    daemon status           Check if daemon auto-start is configured

  Maintenance
    upgrade                 Check for and install updates
    doctor                  Run system health checks
    help                    Show this help message
    version                 Show version number

Options:

  -a, --agent <name>        Agent to use: claude (default), codex, gemini, opencode
  -p, --project <path>      Project directory (default: cwd)
  -f, --force               Force re-authentication
  --skip-pairing            Skip QR code step during onboard
  --skip-doctor             Skip health checks during onboard
  -t, --today               Filter costs to today
  -m, --month               Filter costs to current month
  --follow, -f              Follow daemon logs in real-time
  --lines N, -n N           Show last N lines of logs (default: 50)
  --check, -c               Check for updates without installing
  -h, --help                Show help
  -v, --version             Show version

Environment Variables:

  STYRBY_LOG_LEVEL          Set to "debug" for verbose output
  ANTHROPIC_API_KEY         Required for Claude Code
  OPENAI_API_KEY            Required for Codex, optional for OpenCode
  GEMINI_API_KEY            Required for Gemini CLI
  GOOGLE_API_KEY            Alternative for Gemini CLI

Configuration:

  ~/.styrby/config.json     User configuration
  ~/.styrby/credentials     Authentication tokens (chmod 600)
  ~/.styrby/daemon.pid      Daemon process ID
  ~/.styrby/daemon.log      Daemon output log
  ~/.claude/projects/       Claude Code session data (used by 'costs' command)

Exit Codes:

  0    Success
  1    General error / command failed
  2    Invalid arguments or usage
  126  Permission denied
  127  Command not found (agent not installed)
  130  Interrupted (Ctrl+C)

Examples:

  Getting Started
    styrby onboard                      Complete setup (~60 seconds)
    styrby install claude               Install Claude Code agent
    styrby install opencode             Install OpenCode agent
    styrby doctor                       Verify everything is configured

  Starting Sessions
    styrby start                        Start with Claude (default agent)
    styrby start -a codex               Start with Codex
    styrby start -a gemini              Start with Gemini CLI
    styrby start -a opencode            Start with OpenCode
    styrby start -p ~/work/myproject    Start in specific directory
    styrby start -a codex -p ./backend  Combine agent + project path

  Session Management
    styrby stop                         Stop running daemon
    styrby status                       Check connection and session state
    styrby logs                         View daemon logs (last 50 lines)
    styrby logs -f                      Follow logs in real-time
    styrby logs -n 100                  View last 100 lines

  Daemon Auto-Start
    styrby daemon install               Set up daemon to start on login
    styrby daemon uninstall             Remove daemon from auto-start
    styrby daemon status                Check if auto-start is configured

  Maintenance
    styrby upgrade                      Update to latest version
    styrby upgrade --check              Check for updates without installing

  Cost Tracking
    styrby costs                        Show all-time usage and costs
    styrby costs --today                Show today's costs only
    styrby costs --month                Show current month's costs

  Diagnostics
    styrby doctor                       Run full health check
    STYRBY_LOG_LEVEL=debug styrby start Debug mode with verbose output

  Re-pairing & Re-auth
    styrby pair                         Generate new QR code (e.g., new phone)
    styrby auth --force                 Force re-authentication
    styrby onboard --force              Full re-setup

Troubleshooting:

  Error                           Fix
  ─────────────────────────────────────────────────────────────────────
  "Not authenticated"             styrby onboard (or styrby auth --force)
  "No daemon running"             styrby start --daemon
  "Agent not found"               styrby install <agent> && exec $SHELL
  "Claude: ANTHROPIC_API_KEY"     export ANTHROPIC_API_KEY=sk-ant-...
  "Codex: OPENAI_API_KEY"         export OPENAI_API_KEY=sk-...
  "Gemini: API key"               export GEMINI_API_KEY=... (or GOOGLE_API_KEY)
  "QR code expired"               styrby pair
  "Mobile not connecting"         Check same account on CLI and mobile app
  "Connection timeout"            Whitelist *.supabase.co in firewall/proxy
  "WebSocket blocked"             Some corporate networks block WSS; try hotspot
  "EACCES / permission denied"    mkdir -p ~/.styrby && chmod 700 ~/.styrby
  "Node.js version"               Requires Node.js 20+; check with: node -v
  "Agent crashes on start"        Check agent works standalone: claude --help

  For verbose output, prefix any command with: STYRBY_LOG_LEVEL=debug

Homepage:  https://styrbyapp.com
Source:    https://github.com/VetSecItPro/styrby-app
Issues:    https://github.com/VetSecItPro/styrby-app/issues
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
