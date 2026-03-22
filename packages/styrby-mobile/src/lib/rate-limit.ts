/**
 * Client-Side Rate Limiting
 *
 * Provides a sliding-window rate limiter to prevent accidental API flooding
 * from mobile interactions (e.g., rapid taps on refresh buttons, pull-to-refresh
 * spam, or rapid navigation triggering multiple fetches).
 *
 * WHY: Mobile UIs are prone to accidental rapid taps, especially on refresh
 * controls. Without client-side rate limiting, each tap fires a Supabase query,
 * potentially exceeding Supabase's per-second limits or causing redundant load.
 * This utility throttles calls at the source before they reach the network.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a rate limiter.
 */
export interface RateLimiterOptions {
  /** Maximum number of calls allowed within the time window */
  maxCalls: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Result of a rate-limited function call.
 * Wraps the original function's return value with rate limit metadata.
 */
export interface RateLimitedResult<T> {
  /** Whether the call was allowed (not rate limited) */
  allowed: boolean;
  /** The result of the original function, or undefined if rate limited */
  result?: T;
  /** Number of milliseconds until the next call will be allowed */
  retryAfterMs: number;
}

/**
 * A rate-limited wrapper around an async function.
 * Tracks call timestamps with a sliding window and rejects calls
 * that exceed the configured rate.
 */
export interface RateLimiter<TArgs extends unknown[], TReturn> {
  /**
   * Execute the wrapped function if the rate limit has not been exceeded.
   *
   * @param args - Arguments to pass to the wrapped function
   * @returns A RateLimitedResult containing the call outcome
   */
  call: (...args: TArgs) => Promise<RateLimitedResult<TReturn>>;

  /**
   * Reset the rate limiter, clearing all tracked call timestamps.
   * Useful when the user logs out or the component unmounts.
   */
  reset: () => void;

  /**
   * Get the number of remaining calls allowed in the current window.
   *
   * @returns Number of calls remaining before rate limiting kicks in
   */
  remaining: () => number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Creates a rate limiter that prevents a function from being called
 * more than `maxCalls` times within `windowMs` milliseconds.
 *
 * Uses a sliding window algorithm: each call's timestamp is recorded,
 * and before each new call, timestamps older than `windowMs` are pruned.
 * If the number of timestamps remaining equals or exceeds `maxCalls`,
 * the call is rejected.
 *
 * @param fn - The async function to wrap with rate limiting
 * @param options - Rate limiting configuration (maxCalls, windowMs)
 * @returns A RateLimiter object with call(), reset(), and remaining() methods
 *
 * @example
 * const limiter = createRateLimiter(
 *   async (query: string) => supabase.from('sessions').select(query),
 *   { maxCalls: 5, windowMs: 10000 }
 * );
 *
 * const result = await limiter.call('*');
 * if (!result.allowed) {
 *   console.log(`Rate limited. Retry in ${result.retryAfterMs}ms`);
 * }
 */
export function createRateLimiter<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: RateLimiterOptions,
): RateLimiter<TArgs, TReturn> {
  const { maxCalls, windowMs } = options;

  /** Timestamps of recent calls within the sliding window */
  let callTimestamps: number[] = [];

  /**
   * Remove timestamps that have fallen outside the current window.
   * This keeps the array bounded to at most `maxCalls` entries.
   */
  function pruneExpiredTimestamps(): void {
    const cutoff = Date.now() - windowMs;
    callTimestamps = callTimestamps.filter((ts) => ts > cutoff);
  }

  /**
   * Calculate how long until the oldest call in the window expires,
   * which is when the next call will be allowed.
   *
   * @returns Milliseconds until the rate limit resets for the next call
   */
  function getRetryAfterMs(): number {
    if (callTimestamps.length === 0) return 0;
    const oldestInWindow = callTimestamps[0];
    const expiresAt = oldestInWindow + windowMs;
    return Math.max(0, expiresAt - Date.now());
  }

  const call = async (...args: TArgs): Promise<RateLimitedResult<TReturn>> => {
    pruneExpiredTimestamps();

    if (callTimestamps.length >= maxCalls) {
      return {
        allowed: false,
        retryAfterMs: getRetryAfterMs(),
      };
    }

    callTimestamps.push(Date.now());

    const result = await fn(...args);
    return {
      allowed: true,
      result,
      retryAfterMs: 0,
    };
  };

  const reset = (): void => {
    callTimestamps = [];
  };

  const remaining = (): number => {
    pruneExpiredTimestamps();
    return Math.max(0, maxCalls - callTimestamps.length);
  };

  return { call, reset, remaining };
}

// ============================================================================
// Pre-configured Rate Limiters
// ============================================================================

/**
 * Creates a rate-limited wrapper for Supabase queries.
 *
 * Configured for 10 calls per 5 seconds, which is a reasonable default
 * for mobile UI interactions. This prevents rapid taps from flooding
 * the Supabase API while still allowing responsive interactions.
 *
 * @param fn - The async query function to rate limit
 * @returns A RateLimiter configured for Supabase query patterns
 *
 * @example
 * const rateLimitedRefresh = createRateLimitedFetch(
 *   async () => {
 *     const { data } = await supabase.from('sessions').select('*');
 *     return data;
 *   }
 * );
 *
 * // In a refresh handler:
 * const result = await rateLimitedRefresh.call();
 * if (!result.allowed) {
 *   // Show "Please wait" feedback
 * }
 */
export function createRateLimitedFetch<TReturn>(
  fn: () => Promise<TReturn>,
): RateLimiter<[], TReturn> {
  return createRateLimiter(fn, {
    maxCalls: 10,
    windowMs: 5000,
  });
}
