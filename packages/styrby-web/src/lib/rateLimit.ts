/**
 * Rate Limiting Utility
 *
 * Provides in-memory rate limiting for API endpoints. Uses a sliding window
 * approach with configurable time windows and request limits.
 *
 * WHY: Protects against abuse, prevents resource exhaustion, and ensures fair
 * usage across all users. Different endpoints have different limits based on
 * their cost and sensitivity.
 *
 * Note: For production at scale, consider Redis for distributed rate limiting.
 * The in-memory approach works well for single-instance deployments and
 * serverless with low concurrency.
 */

/**
 * Configuration for a rate limit rule.
 */
type RateLimitConfig = {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  maxRequests: number;
};

/**
 * Internal tracking entry for a single IP/key combination.
 */
type RateLimitEntry = {
  /** Number of requests made in current window */
  count: number;
  /** Timestamp when the window resets */
  resetAt: number;
};

/**
 * In-memory store for rate limit tracking.
 * WHY: Simple Map-based storage is efficient for serverless functions
 * where each instance maintains its own state. For distributed systems,
 * replace with Redis or similar.
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Periodic cleanup of expired entries to prevent memory leaks.
 * WHY: Without cleanup, the Map would grow unbounded as new IPs make requests.
 * Runs every 60 seconds to remove entries that have expired.
 */
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt < now) {
        rateLimitStore.delete(key);
      }
    }
  }, 60000); // Clean up every minute
}

/**
 * Extracts the client IP address from a request.
 *
 * WHY: In production behind a load balancer/CDN (like Vercel), the real IP
 * is in x-forwarded-for. We take the first IP in the chain (original client).
 *
 * @param request - The incoming HTTP request
 * @returns The client's IP address or 'unknown' if not determinable
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Result of a rate limit check.
 */
type RateLimitResult = {
  /** Whether the request is allowed to proceed */
  allowed: boolean;
  /** Number of requests remaining in the current window */
  remaining: number;
  /** Timestamp when the window resets */
  resetAt: number;
  /** Seconds until the client can retry (only present if rate limited) */
  retryAfter?: number;
};

/**
 * Checks and updates rate limit for a request.
 *
 * WHY: Central function for consistent rate limiting across all endpoints.
 * Each endpoint can specify its own config while sharing the same logic.
 *
 * @param request - The incoming HTTP request
 * @param config - Rate limit configuration (window size and max requests)
 * @param keyPrefix - Namespace for this rate limit (prevents collision between endpoints)
 * @returns Rate limit result including whether the request is allowed
 *
 * @example
 * const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.checkout, 'checkout');
 * if (!allowed) {
 *   return rateLimitResponse(retryAfter!);
 * }
 */
export function rateLimit(
  request: Request,
  config: RateLimitConfig,
  keyPrefix: string = 'default'
): RateLimitResult {
  const ip = getClientIp(request);
  const key = `${keyPrefix}:${ip}`;
  const now = Date.now();

  let entry = rateLimitStore.get(key);

  // Create new entry if doesn't exist or expired
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + config.windowMs,
    };
  }

  // Increment count
  entry.count++;
  rateLimitStore.set(key, entry);

  const remaining = Math.max(0, config.maxRequests - entry.count);
  const allowed = entry.count <= config.maxRequests;

  return {
    allowed,
    remaining,
    resetAt: entry.resetAt,
    retryAfter: allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000),
  };
}

/**
 * Pre-configured rate limit settings for common use cases.
 *
 * WHY: Centralizing rate limit configs ensures consistency and makes it easy
 * to adjust limits across the application. Each limit is tuned based on the
 * endpoint's cost and sensitivity.
 */
export const RATE_LIMITS = {
  /**
   * Standard API: 100 requests per minute
   * WHY: Generous limit for regular API calls that aren't particularly expensive.
   */
  standard: { windowMs: 60000, maxRequests: 100 },

  /**
   * Sensitive operations: 10 requests per minute
   * WHY: Operations that modify data or have side effects need tighter limits.
   */
  sensitive: { windowMs: 60000, maxRequests: 10 },

  /**
   * Export: 1 request per hour
   * WHY: Data exports are expensive (fetch all tables) and rarely needed.
   * Also helps prevent data scraping.
   */
  export: { windowMs: 3600000, maxRequests: 1 },

  /**
   * Delete: 1 request per day
   * WHY: Account deletion is a one-time operation. Rate limiting prevents
   * accidental double-clicks and abuse attempts.
   */
  delete: { windowMs: 86400000, maxRequests: 1 },

  /**
   * Checkout: 5 requests per minute
   * WHY: Creating checkout sessions has API costs (Polar) and should be limited.
   * Users don't need more than a few attempts per minute.
   */
  checkout: { windowMs: 60000, maxRequests: 5 },

  /**
   * Budget alerts: 30 requests per minute
   * WHY: CRUD operations are moderate cost. 30/min allows reasonable usage
   * while preventing abuse.
   */
  budgetAlerts: { windowMs: 60000, maxRequests: 30 },

  /**
   * API v1 endpoints: 100 requests per minute
   * WHY: Power tier API access has generous limits for automation.
   * Per-key rate limiting is handled separately in the api-auth middleware.
   */
  apiV1: { windowMs: 60000, maxRequests: 100 },
} as const;

/**
 * Creates a standardized 429 Too Many Requests response.
 *
 * WHY: Consistent error format across all rate-limited endpoints. Includes
 * the Retry-After header as per HTTP spec for rate limiting.
 *
 * @param retryAfter - Seconds until the client can retry
 * @returns A Response object with status 429 and appropriate headers
 *
 * @example
 * if (!allowed) {
 *   return rateLimitResponse(retryAfter!);
 * }
 */
export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  );
}
