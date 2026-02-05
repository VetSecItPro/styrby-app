/**
 * Daemon Runner
 *
 * Manages a background daemon process that maintains a persistent Supabase
 * Realtime connection. The daemon allows the CLI to stay connected even when
 * no terminal is open, so the mobile app can reach the machine at any time.
 *
 * WHY: Without a daemon, closing the terminal kills the Realtime connection
 * and the mobile app loses contact with the machine. The daemon forks a
 * detached child process that survives terminal closure and writes its state
 * to well-known file paths so any CLI invocation can check status or stop it.
 *
 * File layout under ~/.styrby/:
 *   daemon.pid          - PID of the running daemon (plain text)
 *   daemon.status.json  - Connection state, uptime, session info (JSON)
 *   daemon.log          - Stdout/stderr of daemon child process
 *   daemon.sock         - Unix domain socket for IPC commands
 *
 * @module daemon/run
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { CONFIG_DIR, ensureConfigDir } from '@/configuration';
import { logger } from '@/ui/logger';

// ============================================================================
// Constants
// ============================================================================

/** Path to the daemon PID file. Contains the numeric PID. */
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

/** Path to the daemon status file. JSON updated periodically by the daemon. */
const STATUS_FILE = path.join(CONFIG_DIR, 'daemon.status.json');

/** Path to the daemon log file. Captures stdout/stderr from the child process. */
const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the current state of the daemon process.
 * Returned by getDaemonStatus() and written to daemon.status.json by the daemon.
 */
export interface DaemonState {
  /** Whether the daemon process is currently running */
  running: boolean;
  /** PID of the daemon process (if running) */
  pid?: number;
  /** ISO 8601 timestamp of when the daemon started */
  startedAt?: string;
  /** Current Supabase Realtime connection state */
  connectionState?: 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'error';
  /** Number of active relay sessions being managed */
  activeSessions?: number;
  /** Seconds since the daemon started */
  uptimeSeconds?: number;
  /** Last heartbeat timestamp from the daemon */
  lastHeartbeat?: string;
  /** Error message if the daemon is in an error state */
  errorMessage?: string;
}

/**
 * Internal status payload written to daemon.status.json by the child process.
 */
interface DaemonStatusFile {
  pid: number;
  startedAt: string;
  connectionState: DaemonState['connectionState'];
  activeSessions: number;
  lastHeartbeat: string;
  errorMessage?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the daemon process.
 *
 * Forks a detached child process that runs the daemon entry point
 * (daemon/daemonProcess.ts). The child is unref'd so the parent can
 * exit immediately. The child writes its PID to ~/.styrby/daemon.pid
 * and continuously updates ~/.styrby/daemon.status.json.
 *
 * If a daemon is already running, returns its current state without duplicating.
 *
 * @returns Promise resolving to the daemon state after start attempt
 * @throws {Error} If the fork fails for a system-level reason
 *
 * @example
 * const state = await startDaemon();
 * if (state.running) {
 *   console.log(`Daemon running with PID ${state.pid}`);
 * }
 */
export async function startDaemon(): Promise<DaemonState> {
  const existingStatus = getDaemonStatus();
  if (existingStatus.running) {
    logger.debug('Daemon already running', { pid: existingStatus.pid });
    return existingStatus;
  }

  ensureConfigDir();
  cleanupStaleFiles();

  const daemonScript = resolveDaemonScript();
  logger.debug('Starting daemon', { script: daemonScript });

  const logFd = fs.openSync(LOG_FILE, 'a');

  // WHY: detached: true + unref() lets the parent exit while the child
  // stays alive. stdio goes to the log file so closing the terminal
  // does not kill the daemon.
  const child = childProcess.fork(daemonScript, ['--daemon'], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
    env: { ...process.env, STYRBY_DAEMON: '1' },
  });

  const started = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      logger.debug('Daemon start timed out waiting for ready signal');
      resolve(false);
    }, 10_000);

    child.once('message', (msg: unknown) => {
      clearTimeout(timeout);
      if (typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'ready') {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    child.once('error', (err) => {
      clearTimeout(timeout);
      logger.error('Daemon child process error', { error: err.message });
      resolve(false);
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      logger.debug('Daemon child exited prematurely', { code });
      resolve(false);
    });
  });

  // WHY: After the ready signal, the parent no longer needs the IPC channel.
  child.disconnect();
  child.unref();
  fs.closeSync(logFd);

  if (started && child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
    logger.debug('Daemon started', { pid: child.pid });
    return { running: true, pid: child.pid, startedAt: new Date().toISOString(), connectionState: 'connecting' };
  }

  logger.error('Failed to start daemon');
  return { running: false, errorMessage: 'Daemon failed to start within timeout' };
}

/**
 * Stop the running daemon process.
 *
 * Reads the PID from ~/.styrby/daemon.pid, sends SIGTERM, and cleans up
 * state files. Escalates to SIGKILL after 5 seconds.
 *
 * @returns Promise resolving when the daemon has been stopped
 */
export async function stopDaemon(): Promise<void> {
  const pid = readPidFile();
  if (!pid) { cleanupStaleFiles(); return; }
  if (!isProcessAlive(pid)) { cleanupStaleFiles(); return; }

  logger.debug('Sending SIGTERM to daemon', { pid });
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') { cleanupStaleFiles(); return; }
    throw err;
  }

  // WHY: 5 seconds is generous for a clean Realtime disconnect.
  const exited = await waitForProcessExit(pid, 5_000);
  if (!exited) {
    logger.debug('Daemon did not exit after SIGTERM, sending SIGKILL', { pid });
    try { process.kill(pid, 'SIGKILL'); } catch { /* may have exited */ }
    await waitForProcessExit(pid, 2_000);
  }

  cleanupStaleFiles();
  logger.debug('Daemon stopped and cleaned up');
}

/**
 * Get the current status of the daemon.
 *
 * Checks PID file, verifies process is alive (signal 0), reads status file.
 *
 * @returns Current daemon state (always returns, never throws)
 */
export function getDaemonStatus(): DaemonState {
  const pid = readPidFile();
  if (!pid) return { running: false };

  if (!isProcessAlive(pid)) {
    logger.debug('Found stale daemon PID file', { pid });
    return { running: false, errorMessage: 'Daemon process not found (stale PID file)' };
  }

  const statusData = readStatusFile();
  if (statusData) {
    const uptimeSeconds = Math.floor((Date.now() - new Date(statusData.startedAt).getTime()) / 1000);
    return {
      running: true, pid: statusData.pid, startedAt: statusData.startedAt,
      connectionState: statusData.connectionState, activeSessions: statusData.activeSessions,
      uptimeSeconds, lastHeartbeat: statusData.lastHeartbeat, errorMessage: statusData.errorMessage,
    };
  }

  return { running: true, pid, connectionState: 'connecting' };
}

/**
 * Check if the daemon is currently running.
 *
 * @returns True if the daemon process is alive
 */
export function isDaemonRunning(): boolean {
  return getDaemonStatus().running;
}

/**
 * Write or update the daemon status file.
 * Called by the daemon child process to report its state.
 *
 * @param status - Status data to write
 */
export function writeDaemonStatusFile(status: DaemonStatusFile): void {
  ensureConfigDir();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), { mode: 0o600 });
}

// ============================================================================
// Internal Helpers
// ============================================================================

function readPidFile(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/**
 * WHY: Signal 0 checks if the process exists without delivering a signal.
 * Standard POSIX way to probe for a running process.
 */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readStatusFile(): DaemonStatusFile | null {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as DaemonStatusFile;
  } catch { return null; }
}

function cleanupStaleFiles(): void {
  for (const f of [PID_FILE, STATUS_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best-effort */ }
  }
}

/**
 * WHY: In dev we run via tsx (.ts files). In production, esbuild bundles
 * to dist/daemon/daemonProcess.js. We check compiled JS first.
 */
function resolveDaemonScript(): string {
  const distDir = path.resolve(new URL('.', import.meta.url).pathname, '..');
  const jsPath = path.join(distDir, 'daemon', 'daemonProcess.js');
  if (fs.existsSync(jsPath)) return jsPath;

  const srcDir = path.dirname(new URL(import.meta.url).pathname);
  const tsPath = path.join(srcDir, 'daemonProcess.ts');
  if (fs.existsSync(tsPath)) return tsPath;

  return path.join(srcDir, 'daemonProcess.js');
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (!isProcessAlive(pid)) { clearInterval(interval); resolve(true); return; }
      if (Date.now() - start >= timeoutMs) { clearInterval(interval); resolve(false); }
    }, 100);
  });
}

// ============================================================================
// Exports
// ============================================================================

/** Paths to daemon files, exported for use by controlClient and daemonProcess. */
export const DAEMON_PATHS = {
  pidFile: PID_FILE,
  statusFile: STATUS_FILE,
  logFile: LOG_FILE,
  socketPath: path.join(CONFIG_DIR, 'daemon.sock'),
} as const;

export default {
  startDaemon, stopDaemon, getDaemonStatus, isDaemonRunning,
  writeDaemonStatusFile, DAEMON_PATHS,
};
