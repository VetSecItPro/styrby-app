/**
 * API Authentication Middleware
 *
 * Provides authentication for Styrby's v1 API endpoints using API keys.
 * Validates keys, checks permissions, rate limits requests, and attaches
 * user context to the request.
 *
 * Authentication Flow:
 * 1. IP-based pre-auth rate limit (60 req/min/IP) — stops unauthenticated floods
 * 2. Extract API key from Authorization: Bearer sk_live_xxx header
 * 3. Extract prefix and look up candidate keys in database
 * 4. Verify full key against bcrypt hash
 * 5. Check key is not expired or revoked
 * 6. Per-key rate limit: 100 requests per minute per key
 * 7. Update last_used_at tracking
 * 8. Attach user_id to request context
 *
 * Security Notes:
 * - IP-based rate limit prevents unauthenticated flood attacks (H42 Layer 1)
 * - Per-key rate limit prevents abuse by any single credential
 * - Uses bcrypt for constant-time hash comparison
 * - API keys default to 1-year TTL; near-expiry (<30 days) is signalled in responses
 * - All requests are logged to audit_log
 * - Keys can be revoked instantly
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifyApiKey } from '@/lib/api-keys';
import { extractApiKeyPrefix, isValidApiKeyFormat } from '@styrby/shared';
import { getClientIp, rateLimit as checkRateLimit } from '@/lib/rateLimit';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getEnv, getHttpsUrlEnv } from '@/lib/env';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of API key lookup from the database.
 */
interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_hash: string;
  scopes: string[];
  expires_at: string | null;
}

/**
 * Context attached to authenticated API requests.
 */
export interface ApiAuthContext {
  userId: string;
  keyId: string;
  scopes: string[];
  /**
   * ISO 8601 expiration timestamp for the API key, or null if never expires.
   * Included so route handlers and CLI clients can detect near-expiry (<30 days)
   * and prompt the user to rotate before the key stops working.
   * (H42 Item 2)
   */
  keyExpiresAt: string | null;
}

/**
 * Result of API authentication.
 */
export type ApiAuthResult =
  | { success: true; context: ApiAuthContext }
  | { success: false; error: string; status: number };

/**
 * Per-route rate limit override options for withApiAuthAndRateLimit.
 */
export interface RateLimitOptions {
  /** Time window in milliseconds (default: 60000) */
  windowMs?: number;
  /** Maximum requests per window (default: 100) */
  maxRequests?: number;
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Default per-key rate limit: 100 requests per minute.
 * Applied after authentication (key-level isolation).
 */
const API_RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  maxRequests: 100,
};

/**
 * Pre-auth IP-based rate limit: 60 requests per minute per IP.
 *
 * WHY: Applied before we parse the API key. This stops unauthenticated
 * floods (e.g., key enumeration or DDoS against the auth layer itself)
 * from ever reaching the bcrypt verification step.
 * The limit is intentionally lower than the per-key limit so that a
 * single IP cannot exhaust per-key capacity even if it spreads across keys.
 * (H42 Layer 1, SOC2 CC6.6)
 */
const IP_RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  maxRequests: 60,
};

/**
 * Days remaining on an API key before we surface a near-expiry warning hint
 * in API responses. CLI clients check `keyExpiresAt` and prompt rotation.
 */
const KEY_EXPIRY_WARNING_DAYS = 30;

/**
 * Distributed rate limiter for API keys (H-001: replaces in-memory Map).
 *
 * WHY Upstash Redis: On Vercel's serverless platform, each request can land
 * on a different instance. An in-memory Map is per-instance, so a client can
 * bypass limits by distributing requests across instances. Upstash Redis
 * provides shared state across all instances.
 *
 * FALLBACK: If UPSTASH_REDIS_REST_URL is not set (local dev, CI), falls back
 * to in-memory rate limiting (better than no limiting at all).
 */
// WHY getEnv: see packages/styrby-web/src/lib/env.ts for the root-cause write-up.
// Trimmed env access prevents trailing-newline paste errors in Vercel from
// crashing `new Redis({ url })` at module-import time (which 500s every route
// that imports this file).
// getHttpsUrlEnv (not getEnv) rejects placeholder / non-URL values so the
// fallback path engages cleanly instead of the Redis constructor throwing.
const upstashUrl = getHttpsUrlEnv('UPSTASH_REDIS_REST_URL');
const upstashToken = getEnv('UPSTASH_REDIS_REST_TOKEN');
const isRedisConfigured = !!upstashUrl && !!upstashToken;

let apiKeyLimiter: Ratelimit | null = null;
if (isRedisConfigured) {
  try {
    apiKeyLimiter = new Ratelimit({
      redis: new Redis({ url: upstashUrl!, token: upstashToken! }),
      limiter: Ratelimit.slidingWindow(API_RATE_LIMIT.maxRequests, '60 s'),
      prefix: 'styrby:api-key-ratelimit',
      analytics: false,
    });
  } catch (err) {
    console.error(
      '[api-auth] Failed to initialize Upstash Redis rate limiter; falling back to in-memory:',
      err,
    );
  }
}

/** In-memory fallback store for local dev/CI without Redis */
const apiRateLimitStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Checks rate limit for an API key.
 * Uses Upstash Redis when configured, falls back to in-memory.
 *
 * @param keyId - The API key ID to check
 * @returns Whether the request is allowed and retry info if not
 */
async function checkApiRateLimit(keyId: string): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  // Use distributed Redis limiter if available
  if (apiKeyLimiter) {
    try {
      const result = await apiKeyLimiter.limit(keyId);
      return {
        allowed: result.success,
        remaining: result.remaining,
        retryAfter: result.success
          ? undefined
          : Math.ceil((result.reset - Date.now()) / 1000),
      };
    } catch {
      // WHY: If Redis is temporarily unreachable, allow the request rather
      // than blocking all API users. Rate limiting is a safeguard, not a gate.
      return { allowed: true, remaining: API_RATE_LIMIT.maxRequests };
    }
  }

  // In-memory fallback for local dev/CI
  const now = Date.now();
  let entry = apiRateLimitStore.get(keyId);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + API_RATE_LIMIT.windowMs };
  }

  entry.count++;
  apiRateLimitStore.set(keyId, entry);

  const remaining = Math.max(0, API_RATE_LIMIT.maxRequests - entry.count);
  const allowed = entry.count <= API_RATE_LIMIT.maxRequests;

  return {
    allowed,
    remaining,
    retryAfter: allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Supabase Admin Client (bypasses RLS for key lookup)
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase admin client for API key lookup.
 * WHY: API key authentication happens before auth.uid() is set,
 * so we need service role access to look up keys.
 */
function createApiAdminClient() {
  // WHY the URL fallback: Vercel scopes set NEXT_PUBLIC_SUPABASE_URL but
  // not the bare SUPABASE_URL. Reading SUPABASE_URL! alone made this
  // throw "URL and Key required" in prod for any well-formed API key,
  // returning a generic 500 instead of a clean 401.
  return createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}

// ---------------------------------------------------------------------------
// API Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticates an API request using the Authorization header.
 *
 * Runs IP-based pre-auth rate limiting before any key lookup so that
 * unauthenticated floods cannot drive up bcrypt verification cost.
 *
 * @param request - The incoming HTTP request
 * @returns Authentication result with user context or error
 *
 * @example
 * const result = await authenticateApiRequest(request);
 * if (!result.success) {
 *   return NextResponse.json({ error: result.error }, { status: result.status });
 * }
 * const { userId, scopes, keyExpiresAt } = result.context;
 */
export async function authenticateApiRequest(request: NextRequest): Promise<ApiAuthResult> {
  // Step 0: IP-based pre-auth rate limit (H42 Layer 1)
  // WHY: Check before we even parse the key so that key enumeration and
  // unauthenticated floods are stopped at the cheapest possible checkpoint.
  const ipRateLimitResult = await checkRateLimit(request, IP_RATE_LIMIT, 'api-v1-ip');
  if (!ipRateLimitResult.allowed) {
    return {
      success: false,
      error: `Rate limit exceeded. Retry after ${ipRateLimitResult.retryAfter ?? 60} seconds`,
      status: 429,
    };
  }

  // Step 1: Extract API key from Authorization header
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return {
      success: false,
      error: 'Missing Authorization header',
      status: 401,
    };
  }

  // Must be Bearer token
  if (!authHeader.startsWith('Bearer ')) {
    return {
      success: false,
      error: 'Invalid Authorization header format. Use: Bearer sk_live_xxx',
      status: 401,
    };
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer "

  // Step 2: Validate key format
  if (!isValidApiKeyFormat(apiKey)) {
    return {
      success: false,
      error: 'Invalid API key format',
      status: 401,
    };
  }

  const prefix = extractApiKeyPrefix(apiKey);
  if (!prefix) {
    return {
      success: false,
      error: 'Invalid API key prefix',
      status: 401,
    };
  }

  // Step 3: Look up candidate keys by prefix
  const supabase = createApiAdminClient();

  const { data: keyRecords, error: lookupError } = await supabase
    .rpc('lookup_api_key', { p_prefix: prefix });

  if (lookupError) {
    console.error('API key lookup error:', lookupError.message);
    return {
      success: false,
      error: 'Authentication failed',
      status: 500,
    };
  }

  // Type assertion for the RPC result
  const keys = keyRecords as ApiKeyRecord[] | null;

  if (!keys || keys.length === 0) {
    return {
      success: false,
      error: 'Invalid API key',
      status: 401,
    };
  }

  // Step 4: Verify key against each candidate's hash
  let matchedKey: ApiKeyRecord | null = null;

  for (const record of keys) {
    const isValid = await verifyApiKey(apiKey, record.key_hash);
    if (isValid) {
      matchedKey = record;
      break;
    }
  }

  if (!matchedKey) {
    return {
      success: false,
      error: 'Invalid API key',
      status: 401,
    };
  }

  // Step 5: Check expiration (H42 Item 2 — TTL enforcement)
  if (matchedKey.expires_at) {
    const expiresAt = new Date(matchedKey.expires_at);
    if (expiresAt < new Date()) {
      return {
        success: false,
        error: 'API key has expired',
        status: 401,
      };
    }
  }

  // Step 6: Check per-key rate limit (now distributed via Upstash Redis)
  const keyRateLimit = await checkApiRateLimit(matchedKey.id);
  if (!keyRateLimit.allowed) {
    return {
      success: false,
      error: `Rate limit exceeded. Retry after ${keyRateLimit.retryAfter} seconds`,
      status: 429,
    };
  }

  // Step 7: Update usage tracking (fire and forget)
  const clientIp = getClientIp(request);

  // Use void to explicitly ignore the promise result (fire and forget pattern)
  void supabase
    .rpc('update_api_key_usage', {
      p_key_id: matchedKey.id,
      p_ip_address: clientIp !== 'unknown' ? clientIp : null,
    })
    .then(() => {
      // Success - no action needed
    })
    .then(undefined, (err: Error) => {
      console.error('Failed to update API key usage:', err.message);
    });

  // Step 8: Return success with context
  return {
    success: true,
    context: {
      userId: matchedKey.user_id,
      keyId: matchedKey.id,
      scopes: matchedKey.scopes,
      // WHY: Expose expiry so route handlers and CLI clients can surface
      // near-expiry warnings (<30 days) without a separate API call.
      keyExpiresAt: matchedKey.expires_at,
    },
  };
}

/**
 * Creates a standardized error response for API authentication failures.
 *
 * @param error - The error message
 * @param status - The HTTP status code
 * @param extraHeaders - Optional additional response headers (e.g. Retry-After)
 * @returns A NextResponse with the error
 */
export function apiAuthError(
  error: string,
  status: number,
  extraHeaders?: Record<string, string>
): NextResponse {
  const code =
    status === 401
      ? 'UNAUTHORIZED'
      : status === 429
        ? 'RATE_LIMITED'
        : status === 423
          ? 'LOCKED'
          : 'ERROR';

  return NextResponse.json(
    { error, code },
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    }
  );
}

/**
 * Higher-order function that wraps an API route handler with authentication.
 *
 * Includes IP-based pre-auth rate limiting (60 req/min/IP) via
 * authenticateApiRequest, plus per-key rate limiting (100 req/min/key).
 *
 * @param handler - The route handler to wrap
 * @param requiredScopes - Scopes required for this endpoint (default: ['read'])
 * @returns A wrapped handler that checks authentication first
 *
 * @example
 * export const GET = withApiAuth(async (request, context) => {
 *   const { userId } = context;
 *   // ... handle request
 * });
 *
 * // With write scope requirement
 * export const POST = withApiAuth(async (request, context) => {
 *   // ... handle request
 * }, ['write']);
 */
export function withApiAuth(
  handler: (request: NextRequest, context: ApiAuthContext) => Promise<NextResponse>,
  requiredScopes: string[] = ['read']
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const authResult = await authenticateApiRequest(request);

    if (!authResult.success) {
      return apiAuthError(authResult.error, authResult.status);
    }

    // Check required scopes
    const hasRequiredScopes = requiredScopes.every((scope) =>
      authResult.context.scopes.includes(scope)
    );

    if (!hasRequiredScopes) {
      return apiAuthError(
        `Insufficient permissions. Required scopes: ${requiredScopes.join(', ')}`,
        403
      );
    }

    return handler(request, authResult.context);
  };
}

/**
 * Higher-order function that wraps an API route handler with authentication
 * AND per-route rate limit configuration.
 *
 * This is the preferred wrapper for all /api/v1/* route handlers. It provides:
 * - IP-based pre-auth rate limit (default 60 req/min/IP) via authenticateApiRequest
 * - Per-key rate limit (default 100 req/min/key) via authenticateApiRequest
 * - Optional per-route override of the per-key rate limit via `options.rateLimit`
 *
 * WHY a separate function (rather than mutating withApiAuth): The per-key
 * rate limiter is initialized at module load time using the default config.
 * Overriding per-route requires passing config down through auth, which would
 * change the authenticateApiRequest signature. Instead we compose: run auth
 * (which always enforces the IP + default per-key limits), then apply an
 * additional route-level check when the caller specifies a tighter limit.
 * For routes that want the defaults this wrapper is a clean alias for withApiAuth.
 *
 * @param handler - The route handler to wrap
 * @param requiredScopes - Scopes required for this endpoint (default: ['read'])
 * @param options - Optional overrides (e.g. tighter rateLimit for export routes)
 * @returns A wrapped handler that enforces auth + rate limiting
 *
 * @example
 * // Default: 100 req/min per key + 60 req/min per IP
 * export const GET = withApiAuthAndRateLimit(handler);
 *
 * // Custom: 5 req/min per key (export route)
 * export const GET = withApiAuthAndRateLimit(handler, ['read'], {
 *   rateLimit: { windowMs: 60000, maxRequests: 5 },
 * });
 */
export function withApiAuthAndRateLimit(
  handler: (request: NextRequest, context: ApiAuthContext) => Promise<NextResponse>,
  requiredScopes: string[] = ['read'],
  options?: { rateLimit?: RateLimitOptions }
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const authResult = await authenticateApiRequest(request);

    if (!authResult.success) {
      return apiAuthError(authResult.error, authResult.status);
    }

    // Check required scopes
    const hasRequiredScopes = requiredScopes.every((scope) =>
      authResult.context.scopes.includes(scope)
    );

    if (!hasRequiredScopes) {
      return apiAuthError(
        `Insufficient permissions. Required scopes: ${requiredScopes.join(', ')}`,
        403
      );
    }

    // Apply per-route rate limit override when caller requests a tighter window.
    // WHY: authenticateApiRequest already enforces the default 100 req/min/key.
    // Some routes (e.g., data export) need stricter limits. We apply an
    // additional check here using the shared checkRateLimit utility keyed by
    // key ID so the override is per-credential, not per-IP.
    if (options?.rateLimit) {
      const { windowMs = 60000, maxRequests = 100 } = options.rateLimit;
      const routeLimit = await checkRateLimit(
        request,
        { windowMs, maxRequests },
        `api-v1-route:${authResult.context.keyId}`
      );
      if (!routeLimit.allowed) {
        return apiAuthError(
          `Rate limit exceeded. Retry after ${routeLimit.retryAfter ?? 60} seconds`,
          429
        );
      }
    }

    return handler(request, authResult.context);
  };
}

/**
 * Determines if an API key is near expiry (within KEY_EXPIRY_WARNING_DAYS days).
 *
 * Used by route handlers to include a hint in API responses so CLI clients
 * can prompt the user to rotate the key before it stops working.
 *
 * @param expiresAt - ISO 8601 expiration timestamp, or null if no expiry
 * @returns true if the key expires within 30 days, false otherwise
 *
 * @example
 * if (isKeyNearExpiry(context.keyExpiresAt)) {
 *   response.headers.set('X-Api-Key-Expires-At', context.keyExpiresAt!);
 *   response.headers.set('X-Api-Key-Expiry-Warning', 'true');
 * }
 */
export function isKeyNearExpiry(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const msUntilExpiry = new Date(expiresAt).getTime() - Date.now();
  return msUntilExpiry > 0 && msUntilExpiry < KEY_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Adds rate limit headers to a response, and optionally a key-expiry warning.
 *
 * WHY: When using Upstash Redis, the in-memory store may not have the entry.
 * We still set the Limit header so clients know the policy, and best-effort
 * the Remaining/Reset values from the in-memory fallback when available.
 *
 * If `keyExpiresAt` is supplied and the key is within KEY_EXPIRY_WARNING_DAYS
 * days of expiry, we set X-Api-Key-Expiry-Warning and X-Api-Key-Expires-At
 * so CLI clients can surface a rotation prompt. (H42 Item 2)
 *
 * @param response - The response to add headers to
 * @param keyId - The API key ID for rate limit lookup
 * @param keyExpiresAt - Optional ISO 8601 expiry timestamp from the auth context
 * @returns The response with rate limit and optional expiry headers
 */
export function addRateLimitHeaders(
  response: NextResponse,
  keyId: string,
  keyExpiresAt?: string | null
): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(API_RATE_LIMIT.maxRequests));

  const entry = apiRateLimitStore.get(keyId);
  if (entry) {
    const remaining = Math.max(0, API_RATE_LIMIT.maxRequests - entry.count);
    const resetAt = Math.ceil(entry.resetAt / 1000); // Unix timestamp
    response.headers.set('X-RateLimit-Remaining', String(remaining));
    response.headers.set('X-RateLimit-Reset', String(resetAt));
  }

  // Near-expiry warning headers for CLI rotation prompt (H42 Item 2)
  if (keyExpiresAt && isKeyNearExpiry(keyExpiresAt)) {
    response.headers.set('X-Api-Key-Expires-At', keyExpiresAt);
    response.headers.set('X-Api-Key-Expiry-Warning', 'true');
  }

  return response;
}
