/**
 * Logout Command Handler
 *
 * Handles the `styrby logout` command, which performs a full, clean teardown
 * of the user's session:
 *   1. Send `daemon.terminate` IPC RPC (graceful shutdown, waits up to 5s).
 *   2. Fall back to SIGTERM via `stopDaemon()` if the RPC didn't ACK.
 *   3. Call `tokenManager.clearTokens()` to wipe tokens from memory + disk.
 *   4. Print confirmation and exit 0.
 *
 * WHY (SOC 2 CC6.1 — auth context lifecycle): Logout must atomically destroy
 * all auth context AND the daemon's live session. If the daemon keeps running
 * after tokens are cleared it retains a live Realtime subscription under the
 * old identity, which is both a data-integrity and security risk.
 *
 * WHY (OWASP A07:2021 — Identification & Authentication Failures): An
 * incomplete logout that leaves the daemon running or tokens on disk would
 * allow a subsequent local user (or malicious process) to impersonate the
 * previous session. Defense-in-depth requires both layers to be cleared.
 *
 * @module commands/logout
 */

import chalk from 'chalk';
import { terminateDaemon } from '@/daemon/controlClient';
import { stopDaemon } from '@/daemon/run';
import { getTokenManager } from '@/auth/token-manager';
import { logger } from '@/ui/logger';

/**
 * Maximum milliseconds to wait for the daemon to ACK `daemon.terminate`.
 *
 * WHY 5s: Matches the spec requirement. The daemon needs time to persist its
 * final state snapshot and close the Realtime subscription cleanly. 5s is
 * generous enough for a local socket operation while not blocking UX visibly.
 */
const TERMINATE_TIMEOUT_MS = 5_000;

/**
 * Handle the `styrby logout` command.
 *
 * Performs a full, ordered teardown:
 *   1. Guard: if not authenticated, short-circuit with "Not logged in."
 *   2. Send `daemon.terminate` RPC; wait up to 5s for graceful ACK.
 *   3. If ACK not received (ok: false), fall back to SIGTERM via `stopDaemon()`.
 *   4. Clear tokens from memory and disk via `tokenManager.clearTokens()`.
 *   5. Print confirmation and call `process.exit(0)`.
 *
 * All branches exit 0 — logout is always a success state from the user's
 * perspective. Error conditions are logged but do not block token clearance.
 *
 * @param _args - Command-line arguments (currently unused by this command)
 * @returns Promise that resolves when all teardown steps complete (before exit)
 *
 * @throws Never — all errors are caught and logged internally
 *
 * @example
 * // Called from CLI entrypoint
 * case 'logout':
 *   await handleLogout(args.slice(1));
 *   break;
 */
export async function handleLogout(_args: string[]): Promise<void> {
  const tokenManager = getTokenManager();

  // ── Guard: already logged out ───────────────────────────────────────────
  // WHY: isAuthenticated() checks both the in-memory state flag AND whether an
  // access token exists. This short-circuit prevents spurious daemon RPC calls
  // and redundant clearTokens() calls when the user has no active session.
  if (!tokenManager.isAuthenticated()) {
    console.log(chalk.yellow('Not logged in.'));
    process.exit(0);
    return; // unreachable in production; satisfies TypeScript control flow
  }

  // ── Step 1: Attempt graceful daemon shutdown via IPC ────────────────────
  // WHY: `daemon.terminate` asks the daemon to persist state, close its
  // Realtime subscription, and exit cleanly before we wipe tokens.
  // The 5s window matches the spec and gives the daemon enough time to flush
  // its final state snapshot (SOC 2 CC7.2 — reliable processing).
  logger.debug('logout: sending daemon.terminate RPC', { timeoutMs: TERMINATE_TIMEOUT_MS });

  let daemonStoppedCleanly = false;
  try {
    const result = await terminateDaemon(TERMINATE_TIMEOUT_MS);
    daemonStoppedCleanly = result.ok;

    if (result.ok) {
      logger.debug('logout: daemon terminated gracefully');
    } else {
      logger.debug('logout: daemon did not ACK terminate — falling back to SIGTERM');
    }
  } catch (err) {
    // terminateDaemon is documented to never throw (returns { ok: false } on
    // all error paths). This catch is a defensive belt-and-suspenders layer.
    logger.warn('logout: unexpected error from terminateDaemon', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Step 2: SIGTERM fallback if RPC didn't ACK ──────────────────────────
  // WHY: `terminateDaemon` returns `{ ok: false }` for BOTH "daemon not
  // running" and "daemon timed out". In either case, `stopDaemon()` is safe:
  //  - Not running: stopDaemon reads no PID file and returns immediately.
  //  - Timed out: stopDaemon sends SIGTERM, escalates to SIGKILL after 5s.
  // This guarantees no orphaned daemon process remains after logout.
  if (!daemonStoppedCleanly) {
    try {
      logger.debug('logout: calling stopDaemon() as SIGTERM fallback');
      await stopDaemon();
      logger.debug('logout: stopDaemon() completed');
    } catch (err) {
      // A SIGTERM failure is non-fatal for the logout flow — tokens must still
      // be cleared even if we can't kill the daemon (e.g., EPERM).
      // Log the warning so it shows up in support diagnostics.
      logger.warn('logout: stopDaemon() fallback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(
        chalk.yellow(
          'Warning: could not stop daemon. You may need to run `styrby stop` manually.'
        )
      );
    }
  }

  // ── Step 3: Wipe all auth context ───────────────────────────────────────
  // WHY: clearTokens() atomically:
  //  - Resets in-memory state to { isAuthenticated: false }
  //  - Clears tokens from ~/.styrby/data.json (accessToken, refreshToken,
  //    authenticatedAt)
  //  - Clears authToken + userId from the config store
  //  - Emits 'logout' event with { userId } so any remaining subscribers
  //    (e.g., push-token cache) can tear down per-user state
  // Order matters: daemon must be stopped BEFORE clearTokens() so the daemon
  // cannot issue new Supabase requests with tokens that are about to vanish.
  tokenManager.clearTokens();
  logger.debug('logout: tokens cleared');

  // ── Step 4: Confirmation + exit 0 ───────────────────────────────────────
  console.log(
    chalk.green(
      'Logged out. Daemon stopped. Run `styrby login` to sign in again.'
    )
  );

  process.exit(0);
}

export default { handleLogout };
