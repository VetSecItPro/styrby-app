/**
 * Distributed Rate Limiting with Upstash Redis
 *
 * Provides rate limiting that works across all Vercel serverless instances.
 * Uses Upstash Redis (serverless-native) with sliding window algorithm.
 *
 * WHY: The previous in-memory Map-based rate limiter was per-instance only.
 * On Vercel's serverless platform, each function invocation can run on a
 * different instance, so an attacker could bypass limits by hitting different
 * instances. Upstash Redis provides a shared state that all instances read/write.
 *
 * FALLBACK: If UPSTASH_REDIS_REST_URL is not configured, falls back to
 * in-memory rate limiting (better than no rate limiting at all). This allows
 * local development without requiring an Upstash account.
 *
 * @module rateLimit
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Redis Client
// ============================================================================

/**
 * Detect whether Upstash Redis is configured.
 *
 * WHY: In local development and CI, Redis env vars may not be set.
 * We fall back to in-memory rather than crashing at import time.
 */
const isRedisConfigured =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Shared Redis client instance (singleton).
 * Only created if Upstash credentials are available.
 */
const redis = isRedisConfigured
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// ============================================================================
// Rate Limiter Instances (cached per config)
// ============================================================================

/**
 * Cache of Ratelimit instances keyed by prefix.
 *
 * WHY: Creating a new Ratelimit instance per request is wasteful. We cache
 * one instance per prefix (endpoint category) and reuse it across requests.
 */
const limiters = new Map<string, Ratelimit>();

/**
 * Get or create a Ratelimit instance for a given prefix and config.
 *
 * @param prefix - Namespace for this rate limit
 * @param config - Window size and max requests
 * @returns Ratelimit instance configured for this endpoint
 */
function getLimiter(prefix: string, config: RateLimitConfig): Ratelimit {
  const key = `${prefix}:${config.windowMs}:${config.maxRequests}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    // WHY: slidingWindow provides smoother rate limiting than fixedWindow.
    // It prevents burst-at-boundary attacks where a user sends maxRequests
    // at the end of window N and maxRequests at the start of window N+1.
    const windowSeconds = Math.ceil(config.windowMs / 1000);
    const duration = `${windowSeconds} s` as `${number} s`;

    limiter = new Ratelimit({
      redis: redis ?? Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(config.maxRequests, duration),
      prefix: `styrby:ratelimit:${prefix}`,
      analytics: false, // Disable analytics to reduce Redis commands
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

// ============================================================================
// In-Memory Fallback (for local dev / CI without Redis)
// ============================================================================

type InMemoryEntry = {
  count: number;
  resetAt: number;
};

const inMemoryStore = new Map<string, InMemoryEntry>();

/**
 * Fallback in-memory rate limiter for environments without Redis.
 *
 * WHY: Local development and CI don't need distributed rate limiting.
 * This provides the same API surface so callers don't need to check.
 */
function inMemoryRateLimit(
  ip: string,
  config: RateLimitConfig,
  prefix: string
): RateLimitResult {
  const key = `${prefix}:${ip}`;
  const now = Date.now();

  let entry = inMemoryStore.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + config.windowMs };
  }

  entry.count++;
  inMemoryStore.set(key, entry);

  const remaining = Math.max(0, config.maxRequests - entry.count);
  const allowed = entry.count <= config.maxRequests;

  return {
    allowed,
    remaining,
    resetAt: entry.resetAt,
    retryAfter: allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000),
  };
}

// Periodic cleanup for in-memory fallback.
// WHY: The NODE_ENV !== 'test' guard prevents setInterval from leaking into
// Jest/Vitest environments. Test runners flag open handles and warn about
// unresolved timers after test suites complete. In tests the inMemoryStore is
// small and short-lived so eviction is unnecessary (PERF-022).
if (typeof setInterval !== 'undefined' && !isRedisConfigured && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of inMemoryStore.entries()) {
      if (entry.resetAt < now) {
        inMemoryStore.delete(key);
      }
    }
  }, 60000);
}

// ============================================================================
// Public API
// ============================================================================

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
  // SEC-002 FIX: Use the LAST entry in x-forwarded-for, not the first.
  // WHY: Behind Vercel's CDN, the last entry is the CDN-appended trusted IP.
  // The first entry is user-controlled and can be spoofed by setting a custom
  // X-Forwarded-For header, allowing attackers to bypass IP-based rate limits
  // by rotating fake IPs. Vercel always appends the real client IP at the end.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const ips = xff.split(',').map(ip => ip.trim()).filter(Boolean);
    return ips[ips.length - 1] || 'unknown';
  }
  return request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Checks and updates rate limit for a request.
 *
 * Uses Upstash Redis when configured (production), falls back to in-memory
 * for local development and CI.
 *
 * @param request - The incoming HTTP request
 * @param config - Rate limit configuration (window size and max requests)
 * @param keyPrefix - Namespace for this rate limit (prevents collision between endpoints)
 * @returns Rate limit result including whether the request is allowed
 *
 * @example
 * const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.checkout, 'checkout');
 * if (!allowed) {
 *   return rateLimitResponse(retryAfter!);
 * }
 */
export async function rateLimit(
  request: Request,
  config: RateLimitConfig,
  keyPrefix: string = 'default'
): Promise<RateLimitResult> {
  const ip = getClientIp(request);

  // Fallback to in-memory if Redis is not configured
  if (!isRedisConfigured) {
    return inMemoryRateLimit(ip, config, keyPrefix);
  }

  try {
    const limiter = getLimiter(keyPrefix, config);
    const result = await limiter.limit(ip);

    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
      retryAfter: result.success
        ? undefined
        : Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (error) {
    // WHY: If Redis is temporarily unreachable, allow the request rather
    // than blocking all users. Rate limiting is a safeguard, not a gate.
    // Log the error for monitoring but don't break the user experience.
    console.error('Rate limit Redis error (allowing request):', error);
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: Date.now() + config.windowMs,
    };
  }
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
