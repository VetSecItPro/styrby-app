/**
 * StreamingAgentBackendBase - Shared lifecycle primitives for stdout-parsing agents.
 *
 * WHY THIS EXISTS
 * ---------------
 * Prior to this module, eight stdout-parsing agent factories (aider, amp, crush,
 * droid, goose, kilo, kiro, opencode) each reimplemented the same lifecycle
 * plumbing: a `listeners: AgentMessageHandler[]` array, `onMessage` / `offMessage`
 * / `emit`, a `process: ChildProcess | null` reference, a `disposed` flag, and a
 * `setTimeout(SIGKILL, 3000)` escape inside every `cancel()`.
 *
 * Two REAL leaks existed in that duplicated plumbing:
 *
 *   (a) The internal `listeners` array held application-level onMessage handlers.
 *       If external callers never called `offMessage()` and the backend outlived
 *       its consumer (e.g. singleton wrapper, long-running CLI daemon, or a
 *       caller that forgets to dispose), every registered handler stayed
 *       reachable - along with any closures it captured. SOC2 CC7.2 "System
 *       Operations / reliability of processing" treats this as a hygiene issue.
 *
 *   (b) The `setTimeout` scheduled inside `cancel()` for the SIGTERM -> SIGKILL
 *       escalation was never stored. If the process exited cleanly during the
 *       3-second window, or if cancel() was called repeatedly, the timer
 *       remained in the Node.js event loop until it fired. Small per-cancel
 *       timer leak, but it kept the event loop alive and delayed graceful
 *       shutdown of short-lived CLI runs.
 *
 * (Note: child-process `.on('data', ...)` listeners are NOT the leak - those GC
 *  when `this.process = null` runs. The leaks above are at a different layer.)
 *
 * WHAT THIS BASE PROVIDES
 * -----------------------
 * - Centralized `listeners` management with `onMessage` / `offMessage` / `emit`.
 * - Centralized `process` reference + `disposed` flag.
 * - `clearCancelTimer()` - cancels a pending SIGKILL-escalation timer.
 * - `scheduleForceKill()` - stores the escalation timer so it can be cleared.
 * - `spawnAgent()` - single spawn helper that uses `buildSafeEnv` (secret
 *   hygiene) and `validateExtraArgs` (OWASP ASVS V5.3.5, command injection).
 * - `dispose()` - idempotent: clears listeners, clears cancel timer, kills
 *   process with SIGTERM. Safe to call repeatedly.
 *
 * Subclasses keep their agent-specific parsing logic and only adopt the shared
 * lifecycle primitives. No behavioral change intended for any factory.
 *
 * SCOPE
 * -----
 * Streaming (stdout-parsing) agents only. Gemini (shim), Claude/Codex (ACP
 * protocol) intentionally do NOT extend this class - they have different
 * transport semantics and a shared base would become leaky.
 *
 * @module agent/StreamingAgentBackendBase
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from './core';
import { logger } from '@/ui/logger';
import { buildSafeEnv, validateExtraArgs } from '@/utils/safeEnv';

/**
 * How long (ms) to wait after SIGTERM before escalating to SIGKILL.
 *
 * WHY 3000ms: Matches the prior per-factory behavior. Gives well-behaved
 * agents a window to flush stdout and exit cleanly; forces termination
 * afterward so the CLI never hangs on a misbehaving subprocess.
 */
export const FORCE_KILL_DELAY_MS = 3000;

/**
 * Options passed to `spawnAgent()`.
 */
export interface SpawnAgentOptions {
  /** Command to spawn (e.g. 'aider', 'amp'). MUST be a hardcoded string, never user input. */
  command: string;

  /** Fully resolved argv, already including any validated extra args. */
  args: string[];

  /** Working directory for the subprocess. */
  cwd: string;

  /**
   * Extra environment variables to merge on top of the safe-env baseline.
   *
   * SECURITY: These are passed through `buildSafeEnv()`, which applies a
   * strict allowlist and blocks known secret patterns. Factory-specific API
   * keys should be injected here (e.g. `ANTHROPIC_API_KEY`).
   */
  extraEnv?: Record<string, string>;

  /**
   * User-supplied CLI flags to validate before spawn.
   *
   * SECURITY (OWASP ASVS V5.3.5): Passed through `validateExtraArgs()` to
   * block shell metacharacters and command injection attempts.
   */
  userExtraArgs?: string[];

  /** Optional stdio override - defaults to `['pipe', 'pipe', 'pipe']`. */
  stdio?: SpawnOptions['stdio'];
}

/**
 * Abstract base for streaming (stdout-parsing) agent backends.
 *
 * Subclasses implement agent-specific parsing by overriding `startSession`,
 * `sendPrompt`, and `cancel`. Shared lifecycle plumbing (listeners array,
 * process reference, disposal, cancel-timer tracking, safe spawn) is handled
 * here so no factory reimplements it.
 *
 * @see StreamingAgentBackendBase for the full WHY rationale at the top of
 *   this module.
 */
export abstract class StreamingAgentBackendBase implements AgentBackend {
  /**
   * Application-level message handlers.
   *
   * WHY protected (not private): subclasses may inspect length for
   * short-circuit optimizations (e.g. skipping expensive JSON parsing if no
   * one is listening). They MUST NOT mutate this array directly - use
   * `onMessage`/`offMessage`/`dispose`.
   *
   * AUDIT (SOC2 CC7.2): Cleared on `dispose()` so handler closures become
   * eligible for GC even if the backend instance outlives its caller.
   */
  protected listeners: AgentMessageHandler[] = [];

  /** Currently spawned subprocess, or null if none is running. */
  protected process: ChildProcess | null = null;

  /** True after `dispose()` completes; blocks further emits and spawns. */
  protected disposed = false;

  /**
   * SIGTERM -> SIGKILL escalation timer, or undefined when no cancel is in
   * flight.
   *
   * WHY tracked: a raw `setTimeout(..., 3000)` that is never cleared leaks a
   * timer into the event loop for up to 3 seconds after the process has
   * already exited. Storing the ref lets `clearCancelTimer()` cancel it
   * proactively on clean exit / dispose / double-cancel.
   */
  protected cancelTimer?: NodeJS.Timeout;

  /** Active session ID, set by `startSession`. */
  protected sessionId: SessionId | null = null;

  /**
   * Human-readable tag used in log prefixes, e.g. `"AiderBackend"`.
   * Subclasses MUST set this in their constructor for useful debug output.
   */
  protected abstract readonly logTag: string;

  /**
   * Register a handler for agent messages.
   *
   * @param handler - Function to call when messages are received
   */
  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  /**
   * Remove a previously registered message handler.
   *
   * @param handler - The exact handler reference to remove
   */
  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Emit a message to all registered handlers.
   *
   * Catches errors from individual handlers so one bad listener cannot break
   * the event pipeline for the rest.
   *
   * @param msg - The message to dispatch
   */
  protected emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn(`[${this.logTag}] Error in message handler:`, error);
      }
    }
  }

  /**
   * Cancel any pending SIGKILL-escalation timer.
   *
   * Safe to call when no timer is active (no-op). Always called from
   * `dispose()` and should be called from subclass `cancel()` / process-exit
   * handlers to prevent the timer from keeping the event loop alive.
   */
  protected clearCancelTimer(): void {
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
    }
  }

  /**
   * Schedule a SIGKILL to force-terminate `this.process` after the given
   * delay, unless the process exits or `clearCancelTimer()` is called first.
   *
   * Stores the timer reference in `this.cancelTimer` so it can be cleared.
   * Overwrites any previously scheduled force-kill.
   *
   * @param delayMs - Milliseconds to wait before SIGKILL (default 3000)
   */
  protected scheduleForceKill(delayMs: number = FORCE_KILL_DELAY_MS): void {
    this.clearCancelTimer();
    this.cancelTimer = setTimeout(() => {
      this.cancelTimer = undefined;
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }, delayMs);
  }

  /**
   * Spawn an agent subprocess with hardened defaults.
   *
   * SECURITY:
   * - `buildSafeEnv()` filters the env to an allowlist, preventing secret
   *   leakage into third-party CLIs (SOC2 CC6.7 data in transit / at rest
   *   boundary control between our process and an external binary).
   * - `validateExtraArgs()` applies OWASP ASVS V5.3.5 to user-supplied
   *   CLI flags, rejecting shell metacharacters and injection attempts.
   *
   * @param opts - Spawn configuration
   * @returns The spawned ChildProcess (also stored in `this.process`)
   * @throws Error if `userExtraArgs` fails validation
   */
  protected spawnAgent(opts: SpawnAgentOptions): ChildProcess {
    const finalArgs = [...opts.args];
    if (opts.userExtraArgs && opts.userExtraArgs.length > 0) {
      finalArgs.push(...validateExtraArgs(opts.userExtraArgs));
    }

    logger.debug(`[${this.logTag}] Spawning ${opts.command} with args:`, finalArgs);

    const child = spawn(opts.command, finalArgs, {
      cwd: opts.cwd,
      env: buildSafeEnv(opts.extraEnv ?? {}),
      stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    });

    this.process = child;
    return child;
  }

  /**
   * Subclass contract: start a new session.
   *
   * Implementations should call `this.emit({type:'status', status:'starting'})`
   * and set `this.sessionId`.
   */
  abstract startSession(initialPrompt?: string): Promise<StartSessionResult>;

  /**
   * Subclass contract: send a prompt to the running session.
   */
  abstract sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;

  /**
   * Subclass contract: cancel the in-flight prompt.
   *
   * Implementations SHOULD call `this.scheduleForceKill()` after sending
   * SIGTERM so the timer is tracked and cleared on clean exit.
   */
  abstract cancel(sessionId: SessionId): Promise<void>;

  /**
   * Wait for the current response to complete.
   *
   * Default implementation polls `this.process.killed`. Subclasses may
   * override if they have a richer completion signal (e.g. a `done` JSON
   * event on stdout).
   *
   * @param timeoutMs - Maximum milliseconds to wait (default 120000)
   * @throws Error if the timeout elapses before completion
   */
  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (!this.process) return;

    // WHY: Strip the "Backend" suffix from the log tag so timeout error
    // messages read "Timeout waiting for OpenCode response" (matching the
    // pre-refactor phrasing) rather than "...OpenCodeBackend response".
    // Preserves backward compatibility with test assertions.
    const agentLabel = this.logTag.replace(/Backend$/, '');

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${agentLabel} response`));
      }, timeoutMs);

      const poll = (): void => {
        if (!this.process || this.process.killed) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };

      poll();
    });
  }

  /**
   * Respond to a permission request.
   *
   * Default implementation emits a `permission-response` event for
   * UI/logging and is a no-op on the subprocess. Subclasses that need to
   * forward the decision to the agent (e.g. via stdin) should override.
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  /**
   * Clean up all resources.
   *
   * Contract (enforced by StreamingBackendContract test suite):
   * 1. Idempotent - safe to call multiple times.
   * 2. Clears `listeners` array so handler closures are GC-eligible
   *    (SOC2 CC7.2).
   * 3. Clears any pending `cancelTimer` so the event loop is not held open.
   * 4. Kills `process` with SIGTERM if one is active.
   * 5. Sets `disposed = true`, which blocks all further `emit()` and
   *    spawn attempts.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.clearCancelTimer();

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // Process may already be dead; safe to ignore.
      }
      this.process = null;
    }

    // WHY: Drop references to application-level handlers so the closures they
    // capture become GC-eligible. The child-process event listeners GC on
    // their own once `this.process = null` runs.
    this.listeners = [];

    logger.debug(`[${this.logTag}] Disposed`);
  }
}
