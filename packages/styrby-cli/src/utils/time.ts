import crypto from 'node:crypto';

/**
 * Resolves after `ms` milliseconds, pausing the current async task.
 *
 * @param ms - Milliseconds to wait. A value of `0` yields to the event loop
 *   on the next tick without a meaningful delay.
 * @returns A promise that resolves with `undefined` after the timeout fires.
 *
 * @example
 * await delay(500); // pause for 500 ms
 */
export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Computes a randomised exponential-backoff delay (in milliseconds).
 *
 * WHY: Deterministic backoff causes thundering-herd reconnection storms when
 * many clients fail simultaneously. Randomization spreads retry attempts
 * evenly across the window. `crypto.randomInt` is used (M-002: consistent
 * CSPRNG policy) rather than `Math.random` to avoid any statistical bias.
 *
 * The delay grows linearly from `minDelay` to `maxDelay` as `currentFailureCount`
 * approaches `maxFailureCount`, then stays at `maxDelay`.
 *
 * @param currentFailureCount - Number of consecutive failures so far (≥ 0).
 * @param minDelay            - Minimum possible delay in milliseconds.
 * @param maxDelay            - Maximum possible delay in milliseconds.
 * @param maxFailureCount     - The failure count at which the delay saturates
 *   at `maxDelay`. Failures beyond this count do not increase the ceiling.
 * @returns A cryptographically random integer in the range `[1, maxDelayRet]`
 *   where `maxDelayRet` is the linearly interpolated ceiling for this failure count.
 *
 * @example
 * const ms = exponentialBackoffDelay(3, 250, 2000, 10);
 * await delay(ms);
 */
export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    // M-002: Use crypto.randomInt for consistent use of CSPRNG across the codebase
    return crypto.randomInt(Math.max(1, Math.round(maxDelayRet)));
}

/**
 * A factory-produced async retry function with configurable exponential backoff.
 *
 * The returned function re-executes `callback` on each failure, waiting a
 * randomised exponential delay between attempts. It runs indefinitely until
 * `callback` succeeds (resolves) or the caller abandons the promise.
 *
 * @param opts.onError         - Called on each failure with the caught error and
 *   the cumulative failure count. Useful for logging without breaking the retry loop.
 * @param opts.minDelay        - Minimum retry delay in ms (default: 250).
 * @param opts.maxDelay        - Maximum retry delay in ms (default: 1000).
 * @param opts.maxFailureCount - Failure count at which delay saturates (default: 50).
 * @returns An async function `(callback) => Promise<T>` that retries `callback`
 *   until it resolves successfully.
 *
 * @example
 * const retry = createBackoff({ maxDelay: 5000, onError: (e) => logger.warn(e) });
 * const data = await retry(() => fetchRemoteConfig());
 */
export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: unknown, failuresCount: number) => void,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                if (currentFailureCount < maxFailureCount) {
                    currentFailureCount++;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

/**
 * Default backoff instance with standard settings (min 250 ms, max 1000 ms,
 * saturating at 50 consecutive failures).
 *
 * Import and use directly for simple retry scenarios:
 * @example
 * await backoff(() => connectToServer());
 */
export let backoff = createBackoff();
