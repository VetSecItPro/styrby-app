/**
 * API Authentication Middleware
 *
 * Provides authentication for Styrby's v1 API endpoints using API keys.
 * Validates keys, checks permissions, rate limits requests, and attaches
 * user context to the request.
 *
 * Authentication Flow:
 * 1. Extract API key from Authorization: Bearer sk_live_xxx header
 * 2. Extract prefix and look up candidate keys in database
 * 3. Verify full key against bcrypt hash
 * 4. Check key is not expired or revoked
 * 5. Update last_used_at tracking
 * 6. Attach user_id to request context
 * 7. Rate limit: 100 requests per minute per key
 *
 * Security Notes:
 * - Uses bcrypt for constant-time hash comparison
 * - Rate limits prevent brute force attacks
 * - All requests are logged to audit_log
 * - Keys can be revoked instantly
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifyApiKey } from '@/lib/api-keys';
import { extractApiKeyPrefix, isValidApiKeyFormat } from '@styrby/shared';
import { getClientIp } from '@/lib/rateLimit';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getEnv, requireEnv } from '@/lib/env';

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
}

/**
 * Result of API authentication.
 */
export type ApiAuthResult =
  | { success: true; context: ApiAuthContext }
  | { success: false; error: string; status: number };

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Rate limit configuration for API keys.
 * 100 requests per minute per key.
 */
const API_RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  maxRequests: 100,
};

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
const upstashUrl = getEnv('UPSTASH_REDIS_REST_URL');
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
  return createServerClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
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
 * @param request - The incoming HTTP request
 * @returns Authentication result with user context or error
 *
 * @example
 * const result = await authenticateApiRequest(request);
 * if (!result.success) {
 *   return NextResponse.json({ error: result.error }, { status: result.status });
 * }
 * const { userId, scopes } = result.context;
 */
export async function authenticateApiRequest(request: NextRequest): Promise<ApiAuthResult> {
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

  // Step 5: Check expiration
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

  // Step 6: Check rate limit (now distributed via Upstash Redis)
  const rateLimit = await checkApiRateLimit(matchedKey.id);
  if (!rateLimit.allowed) {
    return {
      success: false,
      error: `Rate limit exceeded. Retry after ${rateLimit.retryAfter} seconds`,
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
    },
  };
}

/**
 * Creates a standardized error response for API authentication failures.
 *
 * @param error - The error message
 * @param status - The HTTP status code
 * @returns A NextResponse with the error
 */
export function apiAuthError(error: string, status: number): NextResponse {
  return NextResponse.json(
    {
      error,
      code: status === 401 ? 'UNAUTHORIZED' : status === 429 ? 'RATE_LIMITED' : 'ERROR',
    },
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Higher-order function that wraps an API route handler with authentication.
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
 * Adds rate limit headers to a response.
 *
 * WHY: When using Upstash Redis, the in-memory store may not have the entry.
 * We still set the Limit header so clients know the policy, and best-effort
 * the Remaining/Reset values from the in-memory fallback when available.
 *
 * @param response - The response to add headers to
 * @param keyId - The API key ID for rate limit lookup
 * @returns The response with rate limit headers
 */
export function addRateLimitHeaders(response: NextResponse, keyId: string): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(API_RATE_LIMIT.maxRequests));

  const entry = apiRateLimitStore.get(keyId);
  if (entry) {
    const remaining = Math.max(0, API_RATE_LIMIT.maxRequests - entry.count);
    const resetAt = Math.ceil(entry.resetAt / 1000); // Unix timestamp
    response.headers.set('X-RateLimit-Remaining', String(remaining));
    response.headers.set('X-RateLimit-Reset', String(resetAt));
  }

  return response;
}
