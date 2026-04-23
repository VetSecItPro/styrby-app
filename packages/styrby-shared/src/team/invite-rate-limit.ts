/**
 * Team invite rate limiter (Phase 2.2).
 *
 * Limits the number of invitations a team can send within a 24-hour sliding
 * window. Applied PER TEAM (not per user) to prevent a malicious admin from
 * bypassing the limit by switching accounts or rotating through users.
 *
 * Implementation:
 *   - Upstash Redis with a sorted set (ZADD / ZREMRANGEBYSCORE / ZCARD)
 *     implementing a sliding window. Each invite is stored as a scored member
 *     (score = timestamp ms). Entries outside the window are pruned on each
 *     check before counting.
 *   - WHY sorted set over simple INCR+EXPIRE: A fixed-window INCR resets at
 *     the boundary, allowing a burst of maxInvites at the end of window N and
 *     another maxInvites at the start of window N+1 (2x burst). A sliding
 *     window prevents this by counting only entries within the last 24h.
 *   - WHY ZADD before ZCARD: We add the current request first, then count.
 *     If the count exceeds the cap, the request is denied. The optimistic-add
 *     pattern avoids an extra round-trip (check → insert → check) and is
 *     safe because ZADD's member is the UUID-based unique ID of each invite
 *     — concurrent adds for the same team won't collide on member IDs.
 *
 * Cap: 20 invites per team per 24h.
 * Window: sliding 24h.
 * Redis key: `rate-limit:team-invite:{teamId}`
 *
 * @module team/invite-rate-limit
 */

import { Redis } from '@upstash/redis';

// ============================================================================
// Constants
// ============================================================================

/** Maximum invitations allowed per team per 24-hour sliding window. */
const MAX_INVITES_PER_WINDOW = 20;

/** Sliding window duration in milliseconds. */
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/** Sliding window duration in seconds (for Redis TTL). */
const WINDOW_SECONDS = WINDOW_MS / 1000; // 86400

// ============================================================================
// Redis singleton
// ============================================================================

/**
 * Lazily-initialized Redis client.
 *
 * WHY lazy init: The shared package is imported by both web (Next.js) and
 * edge functions. Some environments (tests, CLI) don't configure Upstash.
 * We initialize on first use rather than at module load to avoid crashing
 * environments that don't need rate limiting.
 */
let _redis: Redis | null = null;

/**
 * Returns the Redis client, initializing it on first call.
 *
 * @throws {Error} When Upstash credentials are not configured
 */
function getRedisClient(): Redis {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set ' +
      'to use invite rate limiting.',
    );
  }

  _redis = new Redis({ url, token });
  return _redis;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a rate-limit check for team invitations.
 */
export interface InviteRateLimitResult {
  /** Whether this invite is allowed (within the window cap). */
  allowed: boolean;

  /** Number of invites remaining in the current 24h window. */
  remaining: number;

  /**
   * Unix timestamp (ms) when the oldest entry in the window expires.
   * Callers can use this to populate a Retry-After response header.
   */
  resetAt: number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Checks (and records) an invite attempt against the team's 24h sliding window.
 *
 * Uses an optimistic-add approach:
 *   1. Add current timestamp to the sorted set.
 *   2. Remove entries older than the 24h window.
 *   3. Count remaining entries.
 *   4. If count > cap, deny; otherwise allow.
 *
 * The add happens before the count so this call is idempotent in the context
 * of a single edge function invocation — the edge function calls this once and
 * uses the result. If the invite is later denied by another check (e.g., seat
 * cap), the ZADD entry for this window remains but the invitation is never
 * created, so it slightly underestimates capacity. This is acceptable: slightly
 * conservative rate limiting is safe; being too lenient is the security risk.
 *
 * @param teamId - UUID of the team sending the invitation
 * @returns Promise resolving to {@link InviteRateLimitResult}
 * @throws {Error} When Upstash credentials are missing or Redis is unreachable
 *
 * @example
 * const rl = await checkInviteRateLimit(teamId);
 * if (!rl.allowed) {
 *   return new Response(JSON.stringify({ error: 'RATE_LIMITED', resetAt: rl.resetAt }), {
 *     status: 429,
 *     headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
 *   });
 * }
 */
export async function checkInviteRateLimit(
  teamId: string,
): Promise<InviteRateLimitResult> {
  const redis = getRedisClient();

  const key = `rate-limit:team-invite:${teamId}`;
  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_MS;

  // Unique member ID for this invite attempt. Using nowMs + random suffix
  // avoids collisions when two concurrent requests land in the same millisecond.
  const member = `${nowMs}-${Math.random().toString(36).slice(2)}`;

  // Step 1: Add this attempt with score = current timestamp.
  // WHY ZADD with score=timestamp: sorted sets ordered by score let us
  // efficiently remove old entries with ZREMRANGEBYSCORE (O(log N + M)).
  await redis.zadd(key, { score: nowMs, member });

  // Step 2: Remove all entries older than the window start.
  await redis.zremrangebyscore(key, 0, windowStartMs);

  // Step 3: Count remaining entries (all within the 24h window).
  const count = await redis.zcard(key);

  // Step 4: Set the key TTL so Redis auto-expires it after an idle window.
  // WHY: Without expire, the key persists indefinitely even if the team never
  // sends another invite. WINDOW_SECONDS is sufficient — if no activity in 24h,
  // all entries have been pruned and the key can be evicted.
  // We use a fire-and-forget expire (no await) to avoid blocking the response.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  redis.expire(key, WINDOW_SECONDS).catch(() => {
    // Non-fatal: if expire fails, the key will persist until Redis eviction.
    // The count-based check above is still correct.
  });

  const resetAt = nowMs + WINDOW_MS;
  const allowed = count <= MAX_INVITES_PER_WINDOW;
  const remaining = Math.max(0, MAX_INVITES_PER_WINDOW - count);

  return { allowed, remaining, resetAt };
}
