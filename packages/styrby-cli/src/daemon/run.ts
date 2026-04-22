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
// In-Process Restart Supervisor
// ============================================================================

/**
 * Maximum number of automatic daemon restarts allowed within the rolling window.
 *
 * WHY 3 restarts in 60 s:
 *   A daemon that crashes more than three times in one minute is almost
 *   certainly in a boot-loop caused by a persistent error (e.g., corrupt
 *   credentials, misconfigured Supabase URL, or a regressed code path).
 *   Continuing to respawn without human intervention wastes CPU, fills the
 *   log file, and could mask the root cause. Three attempts gives the daemon
 *   a fair chance to recover from transient errors (network blip on start,
 *   brief port conflict) while bailing quickly on pathological failures.
 */
const MAX_RESTARTS = 3;

/**
 * Rolling window in ms used for the restart-rate limiter.
 * WHY 60 s: See MAX_RESTARTS comment above.
 */
const RESTART_WINDOW_MS = 60_000;

/**
 * A single entry in the crash log maintained by the restart supervisor.
 */
export interface CrashEntry {
  /** ISO 8601 timestamp of the crash. */
  timestamp: string;
  /** Exit code of the crashed process (null if killed by signal). */
  exitCode: number | null;
  /** Signal that killed the process (null if normal exit). */
  signal: string | null;
  /** How many times the supervisor has restarted the daemon in this run. */
  restartCount: number;
  /**
   * Short hash (8-char hex) of the last error message captured before the crash.
   * Derived by djb2-hashing the error string and formatting as hex.
   * Useful for grouping related crashes without logging full PII-bearing messages.
   */
  crashSignature: string;
}

/**
 * Compute a short, reproducible crash signature from an error message.
 *
 * WHY djb2 instead of crypto.createHash:
 *   This function runs in the parent process before the daemon has started.
 *   We want a deterministic, fast, zero-dependency hash purely for grouping
 *   identical-looking crashes in logs — not for security. djb2 is 5 lines
 *   and produces a stable 8-char hex string for any input.
 *
 * @param msg - Raw error message string
 * @returns 8-character hex digest string
 */
export function crashSignature(msg: string): string {
  let h = 5381;
  for (let i = 0; i < msg.length; i++) {
    h = ((h << 5) + h + msg.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Start a supervised daemon: forks the child process and auto-respawns it
 * on unexpected exits, capped at MAX_RESTARTS within RESTART_WINDOW_MS.
 *
 * WHY in-process supervision in addition to systemd / launchd:
 *   systemd `Restart=on-failure` and launchd `KeepAlive` restart the daemon
 *   at the OS level when the process terminates. However, some daemon errors
 *   are caught by Node.js's `uncaughtException` handler (e.g., a Supabase
 *   SDK assertion mid-session) and do NOT cause the process to exit — they
 *   just leave the relay in an error state. In-process supervision handles
 *   the cases where Node.js itself crashes (SIGSEGV from native add-on,
 *   OOM, assert() in libuv) so the daemon restores itself without needing
 *   a new OS-level service start.
 *
 * After MAX_RESTARTS within RESTART_WINDOW_MS, the supervisor transitions
 * the daemon to `error` state (via the status file) and stops retrying.
 * This prevents infinite boot-loops and lets systemd / launchd take over
 * with their own back-off policies.
 *
 * @returns Promise resolving to the initial daemon state after the first start
 */
export async function startDaemonSupervised(): Promise<DaemonState> {
  const crashLog: CrashEntry[] = [];

  const state = await startDaemon();
  if (!state.running || !state.pid) return state;

  watchAndRespawn(state.pid, crashLog);

  return state;
}

/**
 * Internal helper: poll the daemon PID after each start; if it dies unexpectedly,
 * respawn up to MAX_RESTARTS times within RESTART_WINDOW_MS.
 *
 * @param pid - PID of the running daemon to watch
 * @param crashLog - Mutable array to append CrashEntry records to
 */
function watchAndRespawn(
  pid: number,
  crashLog: CrashEntry[],
): void {
  // WHY 2s poll: fast enough to notice a crash quickly, slow enough to not
  // burn CPU. The daemon typically responds to SIGTERM within ~1s so 2s
  // gives a clean buffer between intentional stops and unexpected exits.
  const POLL_INTERVAL_MS = 2_000;

  const poll = setInterval(() => {
    if (isProcessAlive(pid)) return;

    // Daemon has exited unexpectedly.
    clearInterval(poll);

    // Prune entries older than the rolling window.
    const now = Date.now();
    const recent = crashLog.filter(
      (e) => now - new Date(e.timestamp).getTime() < RESTART_WINDOW_MS
    );

    const lastErr = readLastLogLine();
    const entry: CrashEntry = {
      timestamp: new Date().toISOString(),
      exitCode: null,
      signal: null,
      restartCount: recent.length + 1,
      crashSignature: crashSignature(lastErr),
    };
    crashLog.push(entry);
    recent.push(entry);

    logger.debug('Daemon exited unexpectedly', {
      pid,
      restartCount: entry.restartCount,
      crashSignature: entry.crashSignature,
    });

    if (recent.length > MAX_RESTARTS) {
      // Transition to error state — too many restarts in the window.
      logger.error('Daemon restart cap reached; will not respawn', {
        restartsInWindow: recent.length,
        windowSec: RESTART_WINDOW_MS / 1000,
      });
      writeDaemonStatusFile({
        pid: -1,
        startedAt: new Date().toISOString(),
        connectionState: 'error',
        activeSessions: 0,
        lastHeartbeat: new Date().toISOString(),
        errorMessage: `Daemon crashed ${recent.length} times in ${RESTART_WINDOW_MS / 1000}s — stopped auto-restarting`,
      });
      return;
    }

    // Respawn.
    logger.debug('Respawning daemon', { attempt: entry.restartCount, crashSignature: entry.crashSignature });

    startDaemon().then((newState) => {
      if (newState.running && newState.pid) {
        // Watch the new child too.
        watchAndRespawn(newState.pid, crashLog);
      }
    }).catch((err) => {
      logger.error('Failed to respawn daemon', { error: err.message });
    });
  }, POLL_INTERVAL_MS);

  // WHY unref(): The poll interval must not keep the parent CLI process alive
  // after the user's command completes. If the CLI invocation exits (e.g.,
  // after `styrby start` returns), Node's event loop should be free to exit.
  if (poll.unref) poll.unref();
}

/**
 * Attempt to read the last non-empty line from the daemon log file.
 * Used to derive the crash signature without storing full error messages.
 *
 * @returns Last log line text, or empty string if log is unavailable
 */
function readLastLogLine(): string {
  try {
    if (!fs.existsSync(LOG_FILE)) return '';
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines[lines.length - 1] ?? '';
  } catch {
    return '';
  }
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
  writeDaemonStatusFile, startDaemonSupervised, crashSignature, DAEMON_PATHS,
};
