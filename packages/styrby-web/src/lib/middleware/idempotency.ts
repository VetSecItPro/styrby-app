/**
 * Idempotency Key Middleware
 *
 * Server-side deduplication for state-mutating endpoints (POST, PATCH, DELETE).
 * Mirrors the Stripe idempotency key pattern + Standard Webhooks spec.
 *
 * WHY: The Styrby CLI retries network-failed requests automatically. Without
 * server-side deduplication, a transient error on a checkout or deletion
 * request can cause the operation to execute twice — double-charge or
 * double-delete. This middleware caches successful responses keyed to
 * (Idempotency-Key header, user_id, route) and replays the cached response
 * on duplicate submissions within 24 hours.
 *
 * OWASP A04:2021 (Insecure Design): replay protection.
 *
 * @see https://stripe.com/docs/idempotency
 * @see https://owasp.org/Top10/A04_2021-Insecure_Design/
 * @module lib/middleware/idempotency
 */

import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';

// ============================================================================
// Types
// ============================================================================

/**
 * Result returned by {@link checkIdempotency}.
 *
 * Discriminated union: when `replayed` is false, the caller should proceed
 * with normal handler logic. When `replayed` is true, the caller should
 * return the cached response immediately.
 */
export type IdempotencyResult =
  | {
      /** No cached response found — proceed with handler logic. */
      replayed: false;
    }
  | {
      /** Cached response found — return this to the client without re-executing. */
      replayed: true;
      /** HTTP status code of the original response. */
      status: number;
      /** Response body of the original response, to be returned verbatim. */
      body: unknown;
    };

// ============================================================================
// Request hashing
// ============================================================================

/**
 * Computes a deterministic SHA-256 hash of the request identity.
 *
 * WHY include method + path + body: the hash is used to detect body mismatch
 * on key replay. If a client sends the same Idempotency-Key with a different
 * request body (e.g. different tier, different amount), that is a client bug
 * and must be rejected with 409 Conflict.
 *
 * @param method - HTTP method (e.g. 'POST')
 * @param path - Request pathname (e.g. '/api/billing/checkout/team')
 * @param body - Raw request body string (may be empty string for bodyless requests)
 * @returns Hex-encoded SHA-256 digest
 */
function computeRequestHash(method: string, path: string, body: string): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}:${path}:${body}`)
    .digest('hex');
}

// ============================================================================
// Public API — check
// ============================================================================

/**
 * Checks whether the incoming request is a replay of a previously processed
 * idempotent operation.
 *
 * Call this at the top of every state-mutating handler, before any business
 * logic runs. If `result.replayed` is true, return the cached response
 * immediately and skip all handler logic.
 *
 * Idempotency is opt-in via the `Idempotency-Key` request header. If the
 * header is absent, the function returns `replayed: false` without any
 * database access.
 *
 * Only 2xx responses are cached (set via {@link storeIdempotencyResult}).
 * 4xx/5xx errors are never replayed — the client must retry and may get a
 * different error or a success on the next attempt.
 *
 * @param request - The incoming Next.js request object (or standard Request)
 * @param userId - Authenticated user ID (UUID). Must be resolved before calling.
 * @param route - Normalized route identifier (e.g. '/api/billing/checkout/team').
 *   Use a string constant, not the runtime pathname, to avoid query-string
 *   differences invalidating the cache.
 * @returns Idempotency check result — either `replayed: false` to proceed, or
 *   `replayed: true` with cached status + body.
 *
 * @throws Returns a plain object with a `conflict: true` flag when the same
 *   key was used with a different request body. Callers should detect this and
 *   return 409 Conflict to the client.
 *
 * @example
 * ```ts
 * const idem = await checkIdempotency(req, userId, '/api/billing/checkout/team');
 * if (idem.replayed) {
 *   return NextResponse.json(idem.body, { status: idem.status });
 * }
 * // ... rest of handler ...
 * ```
 */
export async function checkIdempotency(
  request: Request,
  userId: string,
  route: string,
): Promise<IdempotencyResult | { conflict: true; message: string }> {
  // Idempotency is opt-in. No header → proceed without any DB access.
  const idempotencyKey = request.headers.get('idempotency-key') ??
    request.headers.get('Idempotency-Key');

  if (!idempotencyKey) {
    return { replayed: false };
  }

  // Read the body once and compute the request hash.
  // WHY clone(): request body can only be consumed once. We clone so the
  // original stream remains available for the handler to parse after this
  // function returns.
  let rawBody = '';
  try {
    rawBody = await request.clone().text();
  } catch {
    // Body may be unavailable (e.g. GET-like requests forwarded incorrectly).
    // Fall through with empty string — the hash will still be deterministic.
    rawBody = '';
  }

  const url = new URL(request.url);
  const requestHash = computeRequestHash(request.method, url.pathname, rawBody);

  // Service-role client: idempotency_keys has no client-accessible RLS policies.
  // All access is server-side only.
  const adminClient = createAdminClient();

  const { data: existing, error: selectError } = await adminClient
    .from('idempotency_keys')
    .select('request_hash, response_status, response_body, expires_at')
    .eq('key', idempotencyKey)
    .eq('user_id', userId)
    .eq('route', route)
    .maybeSingle();

  if (selectError) {
    // WHY: A DB error on the idempotency check should not block the request.
    // Log and fall through — the handler will run normally. The worst case is
    // a duplicate execution, which is preferable to a hard failure.
    console.error('[idempotency] select error:', selectError.message);
    return { replayed: false };
  }

  if (!existing) {
    // Cache miss — proceed with handler.
    return { replayed: false };
  }

  // Check if the cached row has expired. The cleanup cron handles bulk
  // expiry but we do an inline check here for correctness.
  const expiresAt = new Date(existing.expires_at as string);
  if (expiresAt < new Date()) {
    // Expired entry — treat as a miss and let the handler run fresh.
    return { replayed: false };
  }

  // Cache hit — verify request hash matches.
  if (existing.request_hash !== requestHash) {
    // WHY 409 not 422: the key is valid but the request is inconsistent with
    // the prior use of this key. This is a client programming error (the client
    // reused a key with a different body), not a server-side validation failure.
    // Stripe uses 422 here; we use 409 Conflict to align with RFC 9110.
    return {
      conflict: true,
      message:
        'Idempotency-Key has already been used with a different request body. ' +
        'Use a new key for a different request.',
    };
  }

  // Cache hit — return the original response.
  return {
    replayed: true,
    status: existing.response_status as number,
    body: existing.response_body,
  };
}

// ============================================================================
// Public API — store
// ============================================================================

/**
 * Stores a successful handler response in the idempotency cache.
 *
 * Call this immediately after the handler computes a successful (2xx) response,
 * before returning it to the client. This ensures that a concurrent duplicate
 * request received while the first is in-flight will receive the cached
 * response on its next retry.
 *
 * WHY only cache 2xx: 4xx/5xx errors are transient or client-fixable. Caching
 * a 500 would prevent the client from retrying after the server recovers.
 * Caching a 400 would prevent the client from retrying with a corrected body.
 * Only a successful outcome is idempotent by definition.
 *
 * WHY upsert not insert: a concurrent duplicate request may have already
 * inserted a row between our SELECT (miss) and this INSERT. Upsert handles
 * this race gracefully by overwriting the concurrent insert (the values are
 * identical since the request hash matched).
 *
 * @param request - The incoming request (used to extract key, method, path, body)
 * @param userId - Authenticated user ID
 * @param route - Normalized route identifier (must match the value passed to checkIdempotency)
 * @param status - HTTP status code of the response being stored (should be 2xx)
 * @param body - Response body to cache (will be returned verbatim on replay)
 * @returns Promise that resolves when the cache entry is written (or silently
 *   fails — a write failure does not affect the response returned to the client)
 *
 * @example
 * ```ts
 * const responseBody = { checkout_url: checkout.url };
 * await storeIdempotencyResult(req, userId, '/api/billing/checkout/team', 200, responseBody);
 * return NextResponse.json(responseBody);
 * ```
 */
export async function storeIdempotencyResult(
  request: Request,
  userId: string,
  route: string,
  status: number,
  body: unknown,
): Promise<void> {
  // Only cache successes. Never cache 4xx/5xx — see JSDoc WHY above.
  if (status < 200 || status >= 300) {
    return;
  }

  const idempotencyKey = request.headers.get('idempotency-key') ??
    request.headers.get('Idempotency-Key');

  if (!idempotencyKey) {
    // No key supplied — nothing to cache.
    return;
  }

  let rawBody = '';
  try {
    rawBody = await request.clone().text();
  } catch {
    rawBody = '';
  }

  const url = new URL(request.url);
  const requestHash = computeRequestHash(request.method, url.pathname, rawBody);

  const adminClient = createAdminClient();

  const { error } = await adminClient.from('idempotency_keys').upsert(
    {
      key: idempotencyKey,
      user_id: userId,
      route,
      request_hash: requestHash,
      response_status: status,
      response_body: body,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      onConflict: 'key,user_id,route',
      // WHY ignoreDuplicates false: if a concurrent request already inserted
      // the row, we upsert with the same values to handle the race without error.
      ignoreDuplicates: false,
    },
  );

  if (error) {
    // WHY swallow: a cache write failure is non-fatal. The response was already
    // computed and will be returned to the client. The worst outcome is that the
    // next retry executes the handler again rather than getting the cached result.
    console.error('[idempotency] store error:', error.message);
  }
}
