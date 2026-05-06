/**
 * launchRetryPolicy — bounded-retry decision for the local Claude launcher
 *
 * WHY (B4-Wave3 — error-handling completeness): The launch loop in
 * `claudeLocalLauncher.ts` previously did `while (true) { try { await
 * claudeLocal(...) } catch { continue } }` with no upper bound on retries.
 * If the Claude binary kept failing synchronously (missing PATH entry,
 * corrupted install, missing dependency on first launch after node-modules
 * wipe), the loop burned CPU forever, never surfacing the underlying
 * problem to the user.
 *
 * The policy:
 *   - **Fast failure** = a thrown error that occurs within
 *     `FAST_FAIL_WINDOW_MS` (default 2s) of attempt start.
 *   - **Slow failure** = thrown error after the binary ran for >2s. This
 *     usually indicates a real session that crashed; retry is appropriate.
 *   - After **MAX_CONSECUTIVE_FAST_FAILURES** (default 3) consecutive fast
 *     failures, give up and surface as an error exit code instead of
 *     looping. The user gets a clear error message; the CPU stops burning.
 *   - Slow failures reset the fast-fail counter (a session that ran for a
 *     while + crashed isn't the same problem class as "binary won't start").
 *
 * Extracted as a pure helper so the policy can be unit-tested without
 * spawning real subprocesses.
 *
 * @module claude/utils/launchRetryPolicy
 */

/**
 * A failure that ran for less than this duration counts as "fast" — i.e.
 * the spawn is likely failing synchronously rather than partway through
 * a real session.
 */
export const FAST_FAIL_WINDOW_MS = 2_000;

/**
 * After this many consecutive fast failures, the policy says "give up" —
 * something is structurally broken (missing binary, bad PATH, etc.) and
 * spinning the loop won't fix it.
 */
export const MAX_CONSECUTIVE_FAST_FAILURES = 3;

/**
 * Decision returned by the policy after a launch attempt fails.
 *
 * - `retry` — keep going; the failure looks transient.
 * - `give-up` — too many fast failures in a row; surface as exit code 1.
 */
export type LaunchRetryDecision =
  | { action: 'retry'; consecutiveFastFailures: number }
  | { action: 'give-up'; reason: string; consecutiveFastFailures: number };

/**
 * Internal state carried across launch attempts.
 *
 * Construct one per launcher instance via `createLaunchRetryState()`.
 */
export interface LaunchRetryState {
  consecutiveFastFailures: number;
}

/**
 * Build a fresh retry-state. Call once per launcher invocation.
 */
export function createLaunchRetryState(): LaunchRetryState {
  return { consecutiveFastFailures: 0 };
}

/**
 * Decide whether to retry a launch given how long the previous attempt ran
 * for before it threw, and the cumulative fast-failure count.
 *
 * @param state - Mutable retry state (mutated in-place — the caller's state
 *                object reflects the new counter after the call).
 * @param attemptDurationMs - How long the failed attempt ran before throwing.
 * @returns A decision describing whether to retry or give up.
 *
 * @example
 *   const state = createLaunchRetryState();
 *   const start = Date.now();
 *   try {
 *     await claudeLocal(...);
 *   } catch (e) {
 *     const decision = decideRetry(state, Date.now() - start);
 *     if (decision.action === 'give-up') break;
 *   }
 */
export function decideRetry(
  state: LaunchRetryState,
  attemptDurationMs: number
): LaunchRetryDecision {
  if (attemptDurationMs < FAST_FAIL_WINDOW_MS) {
    state.consecutiveFastFailures += 1;
  } else {
    // Slow failure: reset counter — this is a different problem class.
    state.consecutiveFastFailures = 0;
  }

  if (state.consecutiveFastFailures >= MAX_CONSECUTIVE_FAST_FAILURES) {
    return {
      action: 'give-up',
      reason:
        `Claude binary failed to start ${state.consecutiveFastFailures} times in a row ` +
        `(each within ${FAST_FAIL_WINDOW_MS}ms). Likely cause: missing or unreachable ` +
        `'claude' binary on PATH, or a broken install. Check 'styrby doctor' for diagnostics.`,
      consecutiveFastFailures: state.consecutiveFastFailures,
    };
  }

  return {
    action: 'retry',
    consecutiveFastFailures: state.consecutiveFastFailures,
  };
}
