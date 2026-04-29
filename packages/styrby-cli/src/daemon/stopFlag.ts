/**
 * Daemon Stop-Flag Helpers
 *
 * Manages ~/.styrby/daemon.stop-flag — a small JSON sentinel written by the
 * daemon immediately before an *intentional* shutdown (user-initiated stop,
 * CLI `styrby stop`, or orderly process termination). The supervisor process
 * reads this file on the next restart attempt; if present it suppresses
 * auto-restart and lets the daemon stay stopped.
 *
 * WHY a separate file instead of reusing daemon.state.json:
 *   daemon.state.json describes the session in flight and is written every 30 s
 *   during normal operation. Conflating "I have a live session" state with
 *   "I was intentionally stopped" intent would make the supervisor's decision
 *   logic fragile. A separate sentinel keeps the two concerns cleanly split and
 *   makes the supervisor code straightforward to audit.
 *
 * WHY fail-safe (never throw):
 *   writeStopFlag() is called on the daemon's graceful shutdown path. Any
 *   exception that escapes from here would propagate up through handleTerminate
 *   and potentially deadlock the shutdown or leave the process hanging.
 *   We log the error and resolve regardless so the logout path always completes.
 *
 * WHY fail-safe for stopFlagExists() on malformed JSON:
 *   If the file is corrupt we treat it as absent and let the supervisor
 *   respawn the daemon. Erring toward "restart" is safer than erring toward
 *   "stay stopped" — the user can always run `styrby stop` again, but a daemon
 *   that never restarts after a crash is invisible and confusing.
 *
 * SOC 2 CC7.2 (Reliability of Processing): The stop-flag is operational
 * hygiene that ensures intentional stops are durable across restarts and that
 * crashes are distinguished from deliberate shutdowns.
 *
 * @module daemon/stopFlag
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../ui/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Canonical ~/.styrby config directory (mirrors stateSnapshot.ts convention). */
const CONFIG_DIR = path.join(os.homedir(), '.styrby');

/**
 * Canonical path for the stop-flag sentinel file.
 *
 * WHY a module-level constant computed at import time:
 *   os.homedir() is stable for the lifetime of the process. Computing it once
 *   at module load is consistent with stateSnapshot.ts and avoids repeated
 *   syscalls on the daemon's hot path.
 */
const STOP_FLAG_FILE = path.join(CONFIG_DIR, 'daemon.stop-flag');

// ============================================================================
// Testability override
// ============================================================================

/**
 * Override the stop-flag path at test time.
 *
 * WHY this pattern instead of vi.spyOn(os, 'homedir'):
 *   Node ESM module namespaces are not configurable — vi.spyOn cannot patch
 *   named exports from native node: modules in ESM mode. Accepting an explicit
 *   path override via this setter (mirroring StateSnapshotManager's constructor
 *   parameter) gives tests full isolation without any mock trickery.
 *
 * @param p - Absolute path to use in place of the default ~/.styrby/daemon.stop-flag.
 *            Pass `undefined` to restore the default.
 *
 * @internal Tests only — not part of the public API.
 */
let _stopFlagPathOverride: string | undefined;
export function _setStopFlagPathForTest(p: string | undefined): void {
  _stopFlagPathOverride = p;
}

/** Resolve the effective stop-flag path (default or test override). */
function resolveStopFlagPath(): string {
  return _stopFlagPathOverride ?? STOP_FLAG_FILE;
}

// ============================================================================
// Types
// ============================================================================

/**
 * JSON payload written into the stop-flag file.
 * Intentionally minimal — the supervisor only needs to know the stop was
 * deliberate. The reason and timestamp are for operator diagnostics.
 */
export interface StopFlagPayload {
  /** Always true — sentinel value so the supervisor can verify the file is genuine. */
  intentional: true;
  /** Human-readable reason for the stop (e.g. 'daemon.terminate', 'user-stop'). */
  reason: string;
  /** ISO 8601 timestamp of when the flag was written. */
  exitedAt: string;
}

// ============================================================================
// Public helpers
// ============================================================================

/**
 * Returns the canonical (or test-overridden) path to the stop-flag sentinel file.
 *
 * Exposed for tests and logging — callers should use the other helpers rather
 * than reading/writing the file directly.
 *
 * @returns Absolute path to daemon.stop-flag (default: ~/.styrby/daemon.stop-flag)
 */
export function getStopFlagPath(): string {
  return resolveStopFlagPath();
}

/**
 * Write the stop-flag sentinel to ~/.styrby/daemon.stop-flag.
 *
 * Called by the daemon's graceful shutdown handler immediately before
 * process.exit(). The supervisor checks for this file on the next restart
 * attempt; its presence suppresses auto-restart.
 *
 * WHY never throw: see module-level doc. Shutdown must not deadlock.
 *
 * SOC 2 CC7.2: Durable record that this shutdown was intentional.
 *
 * @param reason - Short description of why the daemon stopped
 *                 (e.g. 'daemon.terminate', 'SIGTERM', 'user-stop').
 * @returns Promise that resolves once the file is written (or on fs failure).
 */
export async function writeStopFlag(reason: string): Promise<void> {
  const payload: StopFlagPayload = {
    intentional: true,
    reason,
    exitedAt: new Date().toISOString(),
  };

  try {
    const flagPath = resolveStopFlagPath();
    // Ensure parent dir exists (mode 0o700 — owner only, mirrors stateSnapshot).
    await fs.promises.mkdir(path.dirname(flagPath), { recursive: true, mode: 0o700 });

    await fs.promises.writeFile(
      flagPath,
      JSON.stringify(payload, null, 2),
      { mode: 0o600 }, // owner read/write only — mirrors daemon.state.json policy
    );
  } catch (err) {
    // WHY warn not error: this is a best-effort write on the shutdown path.
    // The daemon continues exiting regardless.
    logger.warn(
      `stopFlag: failed to write stop-flag (${(err as Error).message}) — shutdown continues`,
    );
  }
}

/**
 * Check whether the stop-flag sentinel file currently exists.
 *
 * The supervisor calls this before deciding whether to auto-restart the daemon.
 *
 * WHY returns false on malformed JSON: see module-level doc.
 *
 * SOC 2 CC7.2: Fail-open toward respawn so a corrupt file does not permanently
 * prevent the daemon from recovering.
 *
 * @returns `true` if a valid stop-flag file is present, `false` otherwise.
 */
export async function stopFlagExists(): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(resolveStopFlagPath(), 'utf-8');
    // WHY validate JSON: an empty or malformed file should not be treated as a
    // genuine intentional-stop signal — treat it as absent and allow respawn.
    const parsed = JSON.parse(raw) as Partial<StopFlagPayload>;
    return parsed.intentional === true;
  } catch {
    // File absent, unreadable, or malformed JSON — fail-safe to false.
    return false;
  }
}

/**
 * Delete the stop-flag sentinel file.
 *
 * Called by the supervisor after it has acted on the flag (e.g., when the user
 * explicitly runs `styrby start` after a prior intentional stop). Idempotent —
 * resolves without error if the file is already absent.
 *
 * SOC 2 CC7.2: Consuming the flag prevents stale sentinel from blocking
 * future legitimate daemon starts.
 *
 * @returns Promise that resolves once the file is deleted (or was already absent).
 */
export async function consumeStopFlag(): Promise<void> {
  try {
    await fs.promises.unlink(resolveStopFlagPath());
  } catch (err) {
    // ENOENT means the file was already absent — that is fine (idempotent).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unexpected error (permissions, etc.) — log but don't throw.
      logger.warn(
        `stopFlag: failed to consume stop-flag (${(err as Error).message})`,
      );
    }
  }
}
