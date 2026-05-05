/**
 * POST /api/v1/sessions/[id]/summary
 *
 * On-demand AI summary generation for a single session. Replaces the
 * auto-fire DB trigger (migration 003) which was dropped in migration 077.
 *
 * Flow:
 *   1. Authenticate via API key (`withApiAuthAndRateLimit`, 'read' scope).
 *      Read scope is sufficient because this endpoint produces a derived
 *      view of session data the user already owns; no destructive write
 *      from the user's perspective.
 *   2. Validate session ID is a UUID.
 *   3. Verify the session belongs to the authenticated user (IDOR 404).
 *   4. Read the user's effective tier (subscriptions + team billing tier).
 *      Free tier -> 403. Summaries are a Pro+ differentiator.
 *   5. Idempotency: if `sessions.summary` is already populated, return
 *      it without invoking the Edge Function.
 *   6. Invoke the `generate-summary` Edge Function via the admin client.
 *      The Edge Function does its own tier check + ownership check and
 *      writes the summary back to the row.
 *   7. Re-read the row to return the freshly stored summary.
 *
 * @auth Required - API key, 'read' scope
 * @rateLimit 30 requests per minute per key (overrides default 100 — summary
 *   generation is expensive and should not be a DOS vector for OpenRouter)
 *
 * @returns 200 { session_id, summary, summary_generated_at, cached: boolean }
 *
 * @error 400 { error } - Invalid session ID
 * @error 401 { error } - Missing/invalid API key (from wrapper)
 * @error 403 { error } - Free tier (TIER_RESTRICTED) or insufficient scope
 * @error 404 { error } - Session not found or owned by another user
 * @error 429 { error } - Rate limit exceeded
 * @error 502 { error } - Edge Function failed (LLM upstream error)
 * @error 500 { error } - Unexpected server error
 *
 * @security OWASP A01:2021 (IDOR): explicit user_id ownership check, 404
 *   on mismatch (no existence leak).
 * @security OWASP A04:2021 (Insecure Design): tier check enforced server-side
 *   even though the UI also gates — never trust the client.
 * @security OWASP A07:2021: auth via withApiAuthAndRateLimit.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  withApiAuthAndRateLimit,
  addRateLimitHeaders,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { resolveEffectiveTier } from '@/lib/tier-enforcement';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * UUID v4 regex used for path-parameter validation.
 *
 * WHY local regex: matches the convention in sibling routes
 * ([id]/route.ts, [id]/messages/route.ts). A shared helper for one regex
 * is over-abstraction.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core POST handler. Wrapped by `withApiAuthAndRateLimit` below with a
 * tighter 30 req/min/key cap (vs. the 100 default) because each call
 * incurs an LLM API cost.
 */
async function handler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId, keyExpiresAt } = context;

  // 1. Parse session ID from path: /api/v1/sessions/<uuid>/summary
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  // Last segment is "summary"; the UUID is the segment before it.
  const sessionId = segments[segments.length - 2];

  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 2. Ownership + idempotency check in a single SELECT.
  // WHY one query: avoids a redundant round-trip when the summary is
  // already cached, which is the common path on repeat clicks.
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, user_id, summary, summary_generated_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (sessionError) {
    console.error(
      '[POST /api/v1/sessions/[id]/summary] session lookup failed:',
      sessionError.message
    );
    return NextResponse.json(
      { error: 'Failed to load session' },
      { status: 500 }
    );
  }

  if (!session) {
    // 404 (not 403) on cross-user ownership mismatch — no existence leak.
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 3. Idempotency: return the cached summary without re-generating.
  // WHY before tier check: a user who downgrades from Pro -> Free should
  // still be able to see summaries that were generated while they were Pro.
  // Tier-gating only the GENERATION action keeps the user-experience sane
  // and matches how every other "feature artifact already exists" pattern
  // in this codebase works.
  if (session.summary && session.summary_generated_at) {
    const response = NextResponse.json({
      session_id: sessionId,
      summary: session.summary,
      summary_generated_at: session.summary_generated_at,
      cached: true,
    });
    return addRateLimitHeaders(response, keyId, keyExpiresAt);
  }

  // 4. Tier gate (only for NEW generation). Pro+ required.
  const tier = await resolveEffectiveTier(supabase, userId);
  if (tier === 'free') {
    return NextResponse.json(
      {
        error: 'TIER_RESTRICTED',
        message: 'AI summaries are available on Pro and Growth plans.',
      },
      { status: 403 }
    );
  }

  // 5. Invoke Edge Function. The function does its own ownership + tier
  // check (defense-in-depth — don't trust this caller exclusively).
  const { data: invokeData, error: invokeError } =
    await supabase.functions.invoke('generate-summary', {
      body: { session_id: sessionId, user_id: userId },
    });

  if (invokeError) {
    console.error(
      '[POST /api/v1/sessions/[id]/summary] Edge Function invocation failed:',
      invokeError.message
    );
    // 502 because the upstream (OpenRouter via Edge Function) failed.
    return NextResponse.json(
      { error: 'Summary generation failed. Please try again.' },
      { status: 502 }
    );
  }

  // The Edge Function returns { success, session_id, summary, ... } on the
  // happy path. We pull the summary from its response so we can return it
  // immediately without an extra DB read on the hot path.
  const summary =
    typeof invokeData === 'object' && invokeData !== null && 'summary' in invokeData
      ? String((invokeData as { summary: unknown }).summary ?? '')
      : '';

  if (!summary) {
    console.error(
      '[POST /api/v1/sessions/[id]/summary] Edge Function returned no summary:',
      JSON.stringify(invokeData)
    );
    return NextResponse.json(
      { error: 'Summary generation returned empty result' },
      { status: 502 }
    );
  }

  const response = NextResponse.json({
    session_id: sessionId,
    summary,
    summary_generated_at: new Date().toISOString(),
    cached: false,
  });
  return addRateLimitHeaders(response, keyId, keyExpiresAt);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * API-key path: 30 req/min/key cap. Tighter than the 100/min default because
 * each call costs LLM tokens. A user clicking "Generate summary" rapidly is
 * bounded; a script trying to flood the OpenRouter bill is hard-stopped.
 */
const apiKeyHandler = withApiAuthAndRateLimit(handler, ['read'], {
  rateLimit: { windowMs: 60_000, maxRequests: 30 },
});

/**
 * POST entry point — selects between API-key auth (CLI / programmatic clients
 * carrying `Authorization: Bearer sk_live_...`) and cookie auth (the dashboard
 * "Generate summary" button, which makes a same-origin fetch with no auth
 * header but a valid Supabase session cookie).
 *
 * WHY a single endpoint with two auth modes (vs. two endpoints):
 *   - The summary semantics (ownership check, tier gate, idempotency, Edge
 *     Function invocation) are identical for both callers. A second route
 *     would duplicate ~120 lines and create a drift surface.
 *   - The request shape and response shape are identical. Same OpenAPI
 *     contract; the auth header is the only differentiator.
 *
 * WHY header-presence (not try-API-key-then-fall-through): if a CLI sends a
 * malformed bearer token we want a clear 401 from the API-key wrapper rather
 * than a confusing fallback to cookie auth that also fails. Header presence
 * is the explicit selector.
 *
 * The cookie path does NOT receive the per-key rate-limit override here. That
 * limiter is keyed by `keyId`, which doesn't exist for cookie auth. Browser
 * fetch is implicitly bounded by user behaviour (one click per click) and
 * the Edge Function itself enforces tier gates as a defense-in-depth limit
 * on cost. If we ever see a need to throttle dashboard-side generation, add
 * a per-user rate limiter keyed by `userId` here — do not retrofit the
 * api-key limiter to dual-purpose.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return apiKeyHandler(request);
  }

  // Cookie path: validate the Supabase session and synthesise an
  // ApiAuthContext for the shared handler. The dashboard never needs scope
  // expansion beyond 'read' for this endpoint — the click-to-generate flow
  // produces a derived view of session data the user already owns.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }

  // OWASP LLM10 (unbounded consumption): API-key path inherits the per-key
  // 30/min rate-limit from withApiAuthAndRateLimit. The cookie-auth path
  // skips that wrapper, so a browser script could spam clicks and spike
  // OpenRouter spend. Apply a per-user rate-limit here to close the gap.
  // Documented 2026-05-05 audit. Limit: same 30/min as the API-key path.
  const { allowed, retryAfter } = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30 },
    `summary:cookie:${user.id}`
  );
  if (!allowed) {
    // rateLimitResponse returns Response; wrap into NextResponse for the
    // route's typed signature.
    const r = rateLimitResponse(retryAfter ?? 60);
    return NextResponse.json(await r.json(), { status: r.status, headers: r.headers });
  }

  const cookieContext: ApiAuthContext = {
    userId: user.id,
    // WHY 'cookie' sentinel keyId: the addRateLimitHeaders helper accepts any
    // string; using a non-UUID literal makes it obvious in logs that this
    // request did NOT come through the API-key wrapper. The shared rate-limit
    // store will simply have no entry for it, which is harmless.
    keyId: 'cookie',
    scopes: ['read'],
    keyExpiresAt: null,
  };

  return handler(request, cookieContext);
}
