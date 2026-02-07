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

// ============================================================================
// Configuration
// ============================================================================

/**
 * Interval in ms between status file updates.
 * WHY: 10 seconds balances freshness with disk I/O. The CLI only reads this
 * file on demand (e.g., styrby status), so sub-second freshness is not needed.
 */
const STATUS_WRITE_INTERVAL_MS = 10_000;

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

  ensureDir(CONFIG_DIR);
  fs.writeFileSync(DAEMON_FILES.pidFile, String(process.pid), { mode: 0o600 });

  setupSignalHandlers();
  startIpcServer();
  await connectToRelay();
  startStatusWriter();

  // Signal parent that we are ready.
  // WHY: The parent waits for this before disconnecting IPC and exiting.
  if (process.send) {
    process.send({ type: 'ready' });
  }

  log('Daemon process ready');
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

    // FIX-019: No hardcoded fallback — URL must come from environment
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

    if (!supabaseUrl) {
      errorMessage = 'SUPABASE_URL not set. Cannot connect to relay.';
      connectionState = 'error';
      log('Cannot connect: no Supabase URL');
      return;
    }

    if (!supabaseAnonKey) {
      // WHY: Without the anon key, Supabase client cannot authenticate.
      errorMessage = 'SUPABASE_ANON_KEY not set. Cannot connect to relay.';
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
    });

    relay.on('error', (err) => {
      connectionState = 'error';
      errorMessage = err.message;
      log('Relay error', err.message);
    });

    relay.on('closed', (info) => {
      if (!shuttingDown) {
        connectionState = 'reconnecting';
        log('Relay closed, will reconnect', info.reason);
      }
    });

    await relay.connect();
  } catch (err) {
    connectionState = 'error';
    errorMessage = err instanceof Error ? err.message : 'Unknown connection error';
    log('Failed to connect to relay', errorMessage);
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
// Signal Handling & Cleanup
// ============================================================================

function setupSignalHandlers(): void {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log('Uncaught exception', err.message);
    errorMessage = `Uncaught: ${err.message}`;
    connectionState = 'error';
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log('Unhandled rejection', msg);
    errorMessage = `Unhandled: ${msg}`;
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

  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

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
