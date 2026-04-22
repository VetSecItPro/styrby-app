/**
 * Daemon Child Process
 *
 * This is the entry point for the forked daemon process. It runs independently
 * of the parent CLI process and maintains a persistent Supabase Realtime
 * connection via the RelayClient.
 *
 * WHY: The daemon child is a separate process so it survives terminal closure.
 * It connects to Supabase Realtime, tracks presence, and listens on a Unix
 * domain socket for IPC commands from CLI invocations (e.g., styrby status).
 *
 * Lifecycle:
 * 1. Parent forks this process with --daemon flag and IPC channel open
 * 2. This process sets up signal handlers, Realtime connection, and IPC server
 * 3. Sends { type: 'ready' } back to parent via IPC
 * 4. Parent disconnects IPC and exits; this process continues running
 * 5. Periodically writes status to ~/.styrby/daemon.status.json
 * 6. On SIGTERM, disconnects cleanly and exits
 *
 * @module daemon/daemonProcess
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { createRelayClient, type RelayClient } from 'styrby-shared';
import { loadDaemonConfig } from './configFile';
import { WakeDetector } from './wakeDetector';
import { stateSnapshot } from './stateSnapshot';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Interval in ms between status file updates.
 * WHY: 10 seconds balances freshness with disk I/O. The CLI only reads this
 * file on demand (e.g., styrby status), so sub-second freshness is not needed.
 */
const STATUS_WRITE_INTERVAL_MS = 10_000;

// ============================================================================
// Structured Logger (inline — daemon has no access to @styrby/shared/logging)
// ============================================================================

/**
 * Minimal structured JSON-lines logger for the daemon process.
 *
 * WHY inline instead of a shared Logger class:
 *   daemonProcess runs as a fully detached child process. The `@/` path alias
 *   resolves relative to the CLI root and is NOT available at runtime in the
 *   detached child. We cannot import from `@/ui/logger` either — that module
 *   imports chalk which attempts to detect a TTY and behaves unexpectedly in
 *   the daemon's non-interactive environment. Defining a minimal inline logger
 *   keeps the daemon self-contained with zero additional dependencies while
 *   emitting the same JSON-lines format as the rest of the codebase.
 *
 * Format: {"ts":"<ISO>","level":"info","tag":"daemon.ready","data":{...}}
 */
const structuredLog = {
  /** Emit an info-level structured log line. */
  info(tag: string, data: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', tag, ...data }));
  },
  /** Emit a warn-level structured log line. */
  warn(tag: string, data: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', tag, ...data }));
  },
  /**
   * Emit an error-level structured log line with optional Error instance.
   *
   * @param tag - Short snake_case tag, e.g. 'daemon.relay_error'
   * @param data - Additional key/value metadata (e.g., error_class)
   * @param err - Optional Error instance for stack-trace capture
   */
  error(tag: string, data: Record<string, unknown> = {}, err?: Error): void {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      tag,
      ...data,
      ...(err ? { message: err.message } : {}),
    }));
  },
};

const CONFIG_DIR = path.join(os.homedir(), '.styrby');

const DAEMON_FILES = {
  pidFile: path.join(CONFIG_DIR, 'daemon.pid'),
  statusFile: path.join(CONFIG_DIR, 'daemon.status.json'),
  socketPath: path.join(CONFIG_DIR, 'daemon.sock'),
  dataFile: path.join(CONFIG_DIR, 'data.json'),
  configFile: path.join(CONFIG_DIR, 'config.json'),
};

// ============================================================================
// State
// ============================================================================

let relay: RelayClient | null = null;
let ipcServer: net.Server | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;
let wakeDetector: WakeDetector | null = null;
const startedAt = new Date().toISOString();
let connectionState: 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'error' = 'disconnected';
let errorMessage: string | undefined;
let shuttingDown = false;

// ============================================================================
// Entry Point
// ============================================================================

/**
 * Main daemon loop. Only runs when invoked with --daemon flag.
 */
async function main(): Promise<void> {
  if (!process.argv.includes('--daemon') && process.env.STYRBY_DAEMON !== '1') {
    console.error('This script should only be run by the Styrby daemon system.');
    process.exit(1);
  }

  log('Daemon process starting', { pid: process.pid });
  structuredLog.info('daemon.starting', { pid: process.pid });

  ensureDir(CONFIG_DIR);
  fs.writeFileSync(DAEMON_FILES.pidFile, String(process.pid), { mode: 0o600 });

  setupSignalHandlers();
  startIpcServer();
  await connectToRelay();
  startStatusWriter();
  startWakeDetector();

  // Start the state snapshot manager.
  // WHY: stateSnapshot.start() reads any prior snapshot BEFORE writing a new
  // one. If the previous daemon crashed mid-session the 'state-restored' event
  // fires so AgentSession can re-attach rather than creating a duplicate record.
  const machineId = (loadJsonFile<{ machineId?: string }>(DAEMON_FILES.dataFile))?.machineId ?? 'unknown';
  stateSnapshot.start({
    machineId,
    currentSessionId: null,
    agentType: null,
    sessionStatus: 'idle',
  });
  stateSnapshot.on('state-restored', (snap) => {
    log('state-restored event', { sessionId: snap.currentSessionId, agentType: snap.agentType });
    structuredLog.info('daemon.state_restored', {
      sessionId: snap.currentSessionId ?? undefined,
      machineId: snap.machineId,
    });
  });

  // Signal parent that we are ready.
  // WHY: The parent waits for this before disconnecting IPC and exiting.
  if (process.send) {
    process.send({ type: 'ready' });
  }

  log('Daemon process ready');
  structuredLog.info('daemon.ready', { pid: process.pid });
}

// ============================================================================
// Supabase Realtime Connection
// ============================================================================

/**
 * Connect to Supabase Realtime using stored credentials.
 */
async function connectToRelay(): Promise<void> {
  connectionState = 'connecting';

  try {
    const data = loadJsonFile<{
      userId?: string;
      accessToken?: string;
      machineId?: string;
    }>(DAEMON_FILES.dataFile);

    if (!data?.userId || !data?.accessToken) {
      errorMessage = 'Not authenticated. Run "styrby onboard" first.';
      connectionState = 'error';
      log('Cannot connect: no credentials found');
      return;
    }

    // Precedence: env vars → ~/.styrby/config.json → error with actionable message.
    //
    // WHY: On macOS, LaunchAgents start before any shell profile (.zshrc, .zprofile)
    // is sourced. SUPABASE_URL and SUPABASE_ANON_KEY are baked into the plist at
    // install time, but the plist may be stale (installed before onboard, or never
    // refreshed). config.json is written on every successful auth and serves as a
    // persistent fallback so the daemon can connect after a reboot even when the
    // plist is stale. See daemon/configFile.ts for the write path.
    const fileConfig = loadDaemonConfig();

    const supabaseUrl = process.env.SUPABASE_URL || fileConfig?.supabaseUrl || '';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || fileConfig?.supabaseAnonKey || '';

    if (!supabaseUrl) {
      errorMessage =
        'SUPABASE_URL not set. Run `styrby onboard` or `styrby daemon install --refresh-install` to fix.';
      connectionState = 'error';
      log('Cannot connect: no Supabase URL');
      return;
    }

    if (!supabaseAnonKey) {
      // WHY: Without the anon key, Supabase client cannot authenticate.
      errorMessage =
        'SUPABASE_ANON_KEY not set. Run `styrby onboard` or `styrby daemon install --refresh-install` to fix.';
      connectionState = 'error';
      log('Cannot connect: no anon key');
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
    });

    const machineId = data.machineId || `daemon_${process.pid}`;

    relay = createRelayClient({
      supabase,
      userId: data.userId,
      deviceId: machineId,
      deviceType: 'cli',
      deviceName: `${os.hostname()} (daemon)`,
      platform: process.platform,
      debug: process.env.STYRBY_LOG_LEVEL === 'debug',
    });

    relay.on('subscribed', () => {
      connectionState = 'connected';
      errorMessage = undefined;
      log('Relay connected');
      structuredLog.info('daemon.relay_connected');
    });

    relay.on('error', (err) => {
      connectionState = 'error';
      errorMessage = err.message;
      log('Relay error', err.message);
      // WHY error_class tagging: the founder dashboard groups these tags to surface
      // "top 3 error classes this week" without full-text scanning.
      structuredLog.error('daemon.relay_error', { error_class: classifyError(err.message) }, err instanceof Error ? err : new Error(err.message));
    });

    relay.on('closed', (info) => {
      if (!shuttingDown) {
        connectionState = 'reconnecting';
        log('Relay closed, will reconnect', info.reason);
        structuredLog.warn('daemon.relay_closed', { reason: info.reason, error_class: 'network' });
      }
    });

    await relay.connect();
  } catch (err) {
    connectionState = 'error';
    errorMessage = err instanceof Error ? err.message : 'Unknown connection error';
    log('Failed to connect to relay', errorMessage);
    structuredLog.error('daemon.relay_connect_failed', { error_class: classifyError(errorMessage) }, err instanceof Error ? err : new Error(errorMessage));
  }
}

// ============================================================================
// IPC Server (Unix Domain Socket)
// ============================================================================

/**
 * Start the IPC server on a Unix domain socket.
 * WHY: Unix domain sockets are the standard POSIX mechanism for local IPC.
 * They are faster than TCP and file-permission-secured.
 */
function startIpcServer(): void {
  const socketPath = DAEMON_FILES.socketPath;

  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* ignore */ }

  ipcServer = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      // WHY: TCP is a stream protocol -- newline delimiting ensures complete JSON.
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) handleIpcCommand(line.trim(), conn);
      }
    });
    conn.on('error', (err) => log('IPC client error', err.message));
  });

  ipcServer.on('error', (err) => log('IPC server error', err.message));
  ipcServer.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* non-fatal */ }
    log('IPC server listening', { socketPath });
  });
}

/**
 * Handle an incoming IPC command from a CLI client.
 *
 * @param rawMessage - Raw JSON string from the client
 * @param conn - The socket connection to respond on
 */
function handleIpcCommand(rawMessage: string, conn: net.Socket): void {
  try {
    const command = JSON.parse(rawMessage) as { type: string };
    let response: Record<string, unknown>;

    switch (command.type) {
      case 'ping':
        response = { success: true, data: { pong: true, pid: process.pid } };
        break;

      case 'status':
        response = {
          success: true,
          data: {
            running: true, pid: process.pid, startedAt, connectionState,
            activeSessions: relay ? relay.getConnectedDevices().length : 0,
            uptimeSeconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
            lastHeartbeat: new Date().toISOString(), errorMessage,
          },
        };
        break;

      case 'stop':
        response = { success: true, data: { stopping: true } };
        conn.write(JSON.stringify(response) + '\n', () => gracefulShutdown('IPC stop command'));
        return;

      case 'list-sessions':
        response = { success: true, data: { devices: relay ? relay.getConnectedDevices() : [] } };
        break;

      case 'attach-relay': {
        // WHY: resume does NOT re-spawn an agent. The daemon re-subscribes its
        // RelayClient to the named session's channel so the mobile app can see
        // the session as live again without a new agent process being launched.
        // If the relay is not yet connected we still ACK success — the relay will
        // pick up the session id on its next reconnect cycle.
        const attachCmd = command as { type: 'attach-relay'; sessionId?: string };
        if (!attachCmd.sessionId) {
          response = { success: false, error: 'attach-relay: sessionId is required' };
          break;
        }
        if (relay) {
          // Re-connect relay, which re-broadcasts presence on the channel.
          // The relay is already keyed on machine_id; a reconnect refreshes
          // last_seen_at on the Supabase side through the presence heartbeat.
          relay.scheduleReconnect(false, 0, 'attach-relay');
        }
        log('attach-relay: scheduling relay reconnect for session', attachCmd.sessionId);
        response = {
          success: true,
          data: { attached: true, sessionId: attachCmd.sessionId },
        };
        break;
      }

      default:
        response = { success: false, error: `Unknown command: ${command.type}` };
    }

    conn.write(JSON.stringify(response) + '\n');
  } catch (err) {
    conn.write(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to parse command',
    }) + '\n');
  }
}

// ============================================================================
// Status Writer
// ============================================================================

/**
 * Start periodic writes to the daemon status file.
 * WHY: Simplest mechanism for the CLI to check daemon state without IPC.
 */
function startStatusWriter(): void {
  const writeStatus = (): void => {
    try {
      const status = {
        pid: process.pid, startedAt, connectionState,
        activeSessions: relay ? relay.getConnectedDevices().length : 0,
        lastHeartbeat: new Date().toISOString(), errorMessage,
      };
      fs.writeFileSync(DAEMON_FILES.statusFile, JSON.stringify(status, null, 2), { mode: 0o600 });
    } catch { /* non-fatal */ }
  };

  writeStatus();
  statusInterval = setInterval(writeStatus, STATUS_WRITE_INTERVAL_MS);
}

// ============================================================================
// Wake Detector (sleep/wake + network-change proactive reconnect)
// ============================================================================

/**
 * Start the WakeDetector and wire its events to the relay client.
 *
 * WHY proactive reconnect instead of waiting for the next backoff tick:
 *   After a macOS sleep/wake or a network topology change the relay WebSocket
 *   is silently dead. Without proactive detection the daemon waits up to 60s
 *   (the backoff ceiling) before the heartbeat timer fires and triggers a
 *   reconnect. With WakeDetector, the relay is back within ~5 seconds of the
 *   wake event — before the user even opens the mobile app.
 *
 * WHY delayMs = 0 (immediate): There is no value in waiting. The OS has
 *   already signalled that something changed; the sooner we attempt reconnect
 *   the sooner the mobile link is live again. If the attempt fails it falls
 *   through to the standard exponential-backoff path.
 */
function startWakeDetector(): void {
  wakeDetector = new WakeDetector();

  wakeDetector.on('wake', () => {
    log('Wake event detected — triggering immediate relay reconnect');
    if (relay && !shuttingDown) {
      relay.scheduleReconnect(false, 0, 'sleep-wake');
    }
  });

  wakeDetector.on('network-change', () => {
    log('Network change detected — triggering immediate relay reconnect');
    if (relay && !shuttingDown) {
      relay.scheduleReconnect(false, 0, 'network-change');
    }
  });

  wakeDetector.start();
  log('WakeDetector started');
}

// ============================================================================
// Signal Handling & Cleanup
// ============================================================================

/**
 * Register OS signal handlers for graceful shutdown.
 *
 * WHY SIGHUP is explicit: `launchctl` (macOS) sends SIGHUP before SIGTERM
 * when restarting a service (e.g., after a system update or `launchctl reload`).
 * Node.js's default behavior on SIGHUP is immediate termination — the same
 * as an unhandled SIGKILL from the daemon's perspective. Without an explicit
 * handler the PID file is not cleaned up, the relay is not disconnected, and
 * the cost-flush queue is not flushed, leaving the daemon in a zombie state
 * that the `styrby status` command reports as running when it isn't.
 *
 * All three signals (SIGHUP, SIGTERM, SIGINT) run the same graceful-shutdown
 * path so the outcome is identical regardless of how the OS stops the process.
 */
function setupSignalHandlers(): void {
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log('Uncaught exception', err.message);
    errorMessage = `Uncaught: ${err.message}`;
    connectionState = 'error';
    structuredLog.error('daemon.uncaught_exception', { error_class: classifyError(err.message) }, err);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log('Unhandled rejection', msg);
    errorMessage = `Unhandled: ${msg}`;
    structuredLog.error('daemon.unhandled_rejection', { error_class: classifyError(msg) }, reason instanceof Error ? reason : new Error(msg));
  });
}

/**
 * Perform graceful shutdown: disconnect relay, close IPC, clean up files.
 *
 * @param reason - Human-readable reason for the shutdown (for logging)
 */
async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Graceful shutdown initiated', { reason });
  structuredLog.info('daemon.shutdown', { reason });

  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

  // WHY: On clean shutdown we remove the snapshot so the next start does not
  // attempt to restore state that was intentionally ended.
  stateSnapshot.clearOnExit();

  if (wakeDetector) { wakeDetector.stop(); wakeDetector = null; }

  if (relay) {
    try { await relay.disconnect(); } catch (err) {
      log('Error disconnecting relay', err instanceof Error ? err.message : 'unknown');
    }
    relay = null;
  }

  if (ipcServer) { ipcServer.close(); ipcServer = null; }

  for (const f of [DAEMON_FILES.socketPath, DAEMON_FILES.pidFile, DAEMON_FILES.statusFile]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best-effort */ }
  }

  log('Daemon shut down cleanly');
  process.exit(0);
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Map an error message string to a broad error class tag.
 *
 * WHY: The founder dashboard surfaces "top 3 error classes this week" by
 * grouping structured log entries on `error_class`. Without this tagging,
 * every unique error message becomes its own bucket and the dashboard shows
 * noise instead of signal. Five classes cover >95% of daemon errors:
 *   - network  : ECONNRESET, ETIMEDOUT, network topology changes
 *   - auth     : token expiry, 401/403 responses
 *   - supabase : PostgREST errors, Realtime subscription failures
 *   - agent_crash : uncaughtException from the agent subprocess
 *   - unknown  : anything that doesn't match the above patterns
 *
 * @param msg - Error message string to classify
 * @returns One of the five error class tags
 */
export function classifyError(msg: string): 'network' | 'auth' | 'supabase' | 'agent_crash' | 'unknown' {
  const m = msg.toLowerCase();
  if (/econnreset|etimedout|econnrefused|enetunreach|network|websocket|ws\s|connect\s/.test(m)) {
    return 'network';
  }
  if (/auth|token|jwt|unauthorized|403|401|forbidden/.test(m)) {
    return 'auth';
  }
  if (/supabase|postgrest|realtime|channel|subscription/.test(m)) {
    return 'supabase';
  }
  if (/uncaught|agent|crash|spawn|child/.test(m)) {
    return 'agent_crash';
  }
  return 'unknown';
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function loadJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch { return null; }
}

function log(message: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [daemon] ${message}`, ...args);
}

// ============================================================================
// Run
// ============================================================================

main().catch((err) => {
  console.error('Daemon fatal error:', err);
  process.exit(1);
});
