/**
 * Daemon State Snapshot
 *
 * Writes a tiny JSON snapshot of the daemon's in-flight session state to
 * ~/.styrby/daemon.state.json every 30 seconds. On the next daemon start,
 * the snapshot is read back and — if it is recent and reflects a live
 * session — a `'state-restored'` event is emitted so AgentSession can
 * re-attach instead of creating a new session record.
 *
 * WHY 30s interval:
 *   Shorter intervals increase disk I/O without meaningfully improving
 *   restore accuracy. If the daemon crashes within the last 30 seconds of
 *   a session, the worst case is re-attaching to a session that ended
 *   slightly before the snapshot was written — harmless, the session is
 *   just marked idle again. 30 s is the pragmatic balance between
 *   freshness and noise-free disk activity.
 *
 * WHY 5-minute staleness threshold:
 *   If the daemon was stopped for longer than 5 minutes the session has
 *   almost certainly been cleaned up server-side. Restoring stale state
 *   would cause a connect attempt to a dead channel, which is worse than
 *   starting fresh. 5 minutes covers routine restarts (OS update, daemon
 *   upgrade, network blip) while rejecting genuine cold starts.
 *
 * WHY mode 0o600:
 *   The snapshot contains machineId and sessionId — not credentials, but
 *   still identifiers that should not be world-readable. Restricting to
 *   owner-read/write follows the same policy as daemon.pid and
 *   daemon.status.json.
 *
 * @module daemon/stateSnapshot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

// ============================================================================
// Constants
// ============================================================================

/**
 * How often the snapshot is refreshed while the daemon runs.
 *
 * WHY 30s: see module-level doc.
 */
export const SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * Maximum age of a snapshot before it is considered stale on startup.
 *
 * WHY 5 min: see module-level doc.
 */
const STALE_THRESHOLD_MS = 5 * 60_000;

const CONFIG_DIR = path.join(os.homedir(), '.styrby');
const SNAPSHOT_FILE = path.join(CONFIG_DIR, 'daemon.state.json');

// ============================================================================
// Types
// ============================================================================

/**
 * Snapshot of the daemon's in-progress session at a point in time.
 * Written to ~/.styrby/daemon.state.json every SNAPSHOT_INTERVAL_MS.
 */
export interface DaemonStateSnapshot {
  /** Registered machine UUID (from machines table). */
  machineId: string;
  /** Active Styrby session UUID, or null if no session is running. */
  currentSessionId: string | null;
  /**
   * The AI agent type for the active session.
   * e.g. 'claude' | 'codex' | 'gemini' | etc.
   */
  agentType: string | null;
  /** ISO 8601 timestamp of the last snapshot write. */
  lastSeenAt: string;
  /**
   * Status of the active session at the time of the snapshot.
   * 'running' and 'reconnecting' are the only states that trigger a
   * state-restore on the next daemon start.
   */
  sessionStatus: 'running' | 'reconnecting' | 'idle' | 'stopped';
}

// ============================================================================
// StateSnapshotManager
// ============================================================================

/**
 * Manages periodic writes of the daemon session snapshot and reads it on
 * startup to emit a `'state-restored'` event when appropriate.
 *
 * Usage:
 * ```ts
 * const snapshotMgr = new StateSnapshotManager();
 * snapshotMgr.on('state-restored', (snap) => {
 *   agentSession.reattach(snap.currentSessionId);
 * });
 * await snapshotMgr.start({ machineId: '...', currentSessionId: null, ... });
 * // ... later
 * snapshotMgr.stop();        // stops the interval
 * snapshotMgr.clearOnExit(); // call in gracefulShutdown to unlink file
 * ```
 */
export class StateSnapshotManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentSnapshot: DaemonStateSnapshot | null = null;
  private snapshotFile: string;

  /**
   * @param snapshotFilePath - Override the default ~/.styrby/daemon.state.json path.
   *                           Primarily used in tests to point at a tmp dir.
   */
  constructor(snapshotFilePath?: string) {
    super();
    this.snapshotFile = snapshotFilePath ?? SNAPSHOT_FILE;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Start the snapshot manager.
   *
   * Reads any existing snapshot file and emits `'state-restored'` if it is
   * recent enough and describes a live session. Then begins the periodic
   * write interval.
   *
   * WHY we rename (not ignore) the snapshot before processing:
   *   If the daemon crashes during state-restore (before it can write a fresh
   *   snapshot), the next start would try to restore from the same stale file
   *   again, potentially loop-restoring a broken session. Renaming to
   *   `.bak` before reading moves it aside atomically, so a crash between
   *   start() and the first interval tick does not re-trigger restore.
   *
   * @param initialState - Initial snapshot values for the new daemon run.
   */
  start(initialState: Omit<DaemonStateSnapshot, 'lastSeenAt'>): void {
    // Move aside the existing snapshot before attempting restore.
    // WHY: See "why we rename" in JSDoc above.
    const existing = this._moveSnapshotAside();
    if (existing) {
      const ageSec = (Date.now() - new Date(existing.lastSeenAt).getTime()) / 1000;
      const isRestorable =
        (existing.sessionStatus === 'running' || existing.sessionStatus === 'reconnecting') &&
        Date.now() - new Date(existing.lastSeenAt).getTime() < STALE_THRESHOLD_MS;

      if (isRestorable) {
        // WHY queueMicrotask: emitting asynchronously lets callers attach
        // 'state-restored' listeners synchronously in the same turn.
        // We use queueMicrotask (runs before the next I/O event) rather than
        // process.nextTick so that vi.useFakeTimers() in tests does not
        // interfere — fake timers do not control microtasks.
        queueMicrotask(() => {
          this.emit('state-restored', existing);
        });
      } else {
        // Snapshot is stale or describes a stopped session — discard silently.
        // Log at debug level for diagnostics.
        this._log(
          `stateSnapshot: skipping restore (status=${existing.sessionStatus}, age=${Math.round(ageSec)}s)`
        );
      }
    }

    this.currentSnapshot = {
      ...initialState,
      lastSeenAt: new Date().toISOString(),
    };
    this._write();

    // WHY: We write immediately on start so there is always a fresh snapshot
    // even if the daemon crashes before the first interval tick.
    this.timer = setInterval(() => {
      if (this.currentSnapshot) {
        this.currentSnapshot.lastSeenAt = new Date().toISOString();
        this._write();
      }
    }, SNAPSHOT_INTERVAL_MS);

    // WHY unref(): The interval must not keep the Node.js event loop alive if
    // the daemon is shutting down. clearOnExit() calls clearInterval explicitly;
    // unref() is a safety net for cases where clearInterval is skipped (e.g.,
    // an uncaught exception that bypasses the shutdown path).
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Update the snapshot fields while the daemon is running.
   * The next interval tick will persist the updated values.
   *
   * @param patch - Partial snapshot fields to merge in.
   */
  update(patch: Partial<Omit<DaemonStateSnapshot, 'lastSeenAt'>>): void {
    if (!this.currentSnapshot) return;
    Object.assign(this.currentSnapshot, patch);
    // Write immediately so a crash right after update() captures fresh state.
    this.currentSnapshot.lastSeenAt = new Date().toISOString();
    this._write();
  }

  /**
   * Stop the periodic write interval.
   * Does NOT unlink the snapshot file — call clearOnExit() for that.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Unlink the snapshot file on clean shutdown.
   *
   * WHY: On a clean shutdown the next start should NOT attempt to restore
   * state (the user or systemd intentionally stopped the daemon). Removing
   * the file ensures a cold start is treated as cold.
   */
  clearOnExit(): void {
    this.stop();
    try {
      if (fs.existsSync(this.snapshotFile)) fs.unlinkSync(this.snapshotFile);
    } catch { /* best-effort */ }
    // Also remove the .bak if it was left from a previous crashed start.
    try {
      const bak = this.snapshotFile + '.bak';
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
    } catch { /* best-effort */ }
  }

  /**
   * Return the current in-memory snapshot (for tests).
   */
  getCurrent(): DaemonStateSnapshot | null {
    return this.currentSnapshot ? { ...this.currentSnapshot } : null;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Read the snapshot file and move it to .bak atomically.
   * Returns the parsed snapshot, or null if it does not exist or is invalid.
   */
  private _moveSnapshotAside(): DaemonStateSnapshot | null {
    if (!fs.existsSync(this.snapshotFile)) return null;
    try {
      const raw = fs.readFileSync(this.snapshotFile, 'utf-8');
      const bak = this.snapshotFile + '.bak';
      fs.renameSync(this.snapshotFile, bak);
      return JSON.parse(raw) as DaemonStateSnapshot;
    } catch {
      // Corrupt or unreadable — treat as no snapshot.
      try { fs.unlinkSync(this.snapshotFile); } catch { /* ignore */ }
      return null;
    }
  }

  private _write(): void {
    if (!this.currentSnapshot) return;
    try {
      const dir = path.dirname(this.snapshotFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.snapshotFile, JSON.stringify(this.currentSnapshot, null, 2), {
        mode: 0o600,
      });
    } catch { /* non-fatal */ }
  }

  private _log(msg: string): void {
    console.log(`[${new Date().toISOString()}] [daemon] ${msg}`);
  }
}

// ============================================================================
// Module-level singleton (for daemon process use)
// ============================================================================

/** Shared singleton used by daemonProcess.ts. */
export const stateSnapshot = new StateSnapshotManager();
