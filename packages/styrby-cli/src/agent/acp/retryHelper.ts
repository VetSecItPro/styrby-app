/**
 * Retry helper for ACP operations.
 *
 * WHY: ACP agent subprocesses (Crush, Gemini CLI, etc.) are flaky on first
 * connect — JSON-RPC initialize and newSession can race against the agent's
 * own startup. Without retry, a transient failure aborts the whole session.
 * Exponential backoff with a small attempt cap recovers without hammering.
 */

import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';

/**
 * Default retry configuration for ACP init/newSession operations.
 *
 * WHY: 3 attempts × (1s, 2s, 4s capped at 5s) = ~7s worst case. Long enough
 * to ride out a slow agent boot, short enough that a real failure surfaces
 * quickly to the user.
 */
export const RETRY_CONFIG = {
  /** Maximum number of retry attempts for init/newSession */
  maxAttempts: 3,
  /** Base delay between retries in ms */
  baseDelayMs: 1000,
  /** Maximum delay between retries in ms */
  maxDelayMs: 5000,
} as const;

/**
 * Options controlling a single {@link withRetry} invocation.
 */
export interface WithRetryOptions {
  /** Human-readable name for the operation, used in debug logs. */
  operationName: string;
  /** Maximum number of attempts (inclusive of the first try). */
  maxAttempts: number;
  /** Initial backoff delay in milliseconds. */
  baseDelayMs: number;
  /** Cap on the backoff delay in milliseconds. */
  maxDelayMs: number;
  /** Optional hook fired before each retry attempt (after the failure). */
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Run an async operation with exponential-backoff retry.
 *
 * @param operation - The async function to retry on rejection.
 * @param options   - Retry policy configuration; see {@link WithRetryOptions}.
 * @returns The resolved value of the first successful attempt.
 * @throws The last captured error if all attempts fail.
 *
 * @example
 * await withRetry(() => connection.initialize(req), {
 *   operationName: 'Initialize',
 *   maxAttempts: RETRY_CONFIG.maxAttempts,
 *   baseDelayMs: RETRY_CONFIG.baseDelayMs,
 *   maxDelayMs: RETRY_CONFIG.maxDelayMs,
 * });
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < options.maxAttempts) {
        // WHY: Exponential backoff (2^(n-1) * base) clamped to maxDelayMs avoids
        // unbounded waits if the cap is misconfigured.
        const delayMs = Math.min(
          options.baseDelayMs * Math.pow(2, attempt - 1),
          options.maxDelayMs
        );

        logger.debug(
          `[AcpBackend] ${options.operationName} failed (attempt ${attempt}/${options.maxAttempts}): ${lastError.message}. Retrying in ${delayMs}ms...`
        );
        options.onRetry?.(attempt, lastError);

        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * Race a promise against a timeout, rejecting if the timeout fires first.
 *
 * WHY: ACP RPCs (initialize, newSession) can hang indefinitely if the agent
 * subprocess deadlocks. Promise.race with a setTimeout reject path bounds
 * the wait, and the finally block guarantees the timer is cleared so the
 * Node event loop can exit cleanly even on success.
 *
 * @param promiseFactory - A function that produces the operation promise.
 * @param timeoutMs      - Maximum time to wait, in milliseconds.
 * @param timeoutMessage - Error message used when the timeout fires.
 */
export async function withTimeout<T>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promiseFactory().then((res) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        return res;
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
