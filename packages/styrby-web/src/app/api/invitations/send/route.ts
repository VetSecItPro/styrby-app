/**
 * POST /api/invitations/send
 *
 * Thin proxy to the Unit A edge function (supabase/functions/teams-invite).
 * Authenticates the caller via Supabase, then forwards the request to the
 * edge function with the caller's JWT. All business logic (seat cap, rate
 * limit, token generation) lives in the edge function.
 *
 * WHY a proxy instead of calling the edge function from the client:
 *   1. The client does not have direct access to the Supabase project URL.
 *   2. We can add web-layer rate limiting, logging, or request shaping here
 *      without touching the edge function.
 *   3. CORS is simpler when all client requests go through /api/...
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   team_id: string (UUID),
 *   email: string,
 *   role: 'admin' | 'member' | 'viewer'
 * }
 *
 * @returns 200 { invitation_id: string, expires_at: string }
 *
 * @error 400 { error: 'VALIDATION_ERROR', details: ZodError }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 402 { error: 'SEAT_CAP_EXCEEDED', upgradeCta: string, ... } (propagated)
 * @error 403 { error: 'FORBIDDEN', message: string } (propagated)
 * @error 409 { error: 'CONCURRENT_INVITE', message: string } (propagated)
 * @error 429 { error: 'RATE_LIMITED', resetAt: number, ... } (propagated)
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Proxies a team invitation request to the Supabase edge function.
 *
 * WHY we forward the Authorization header rather than a service-role key:
 *   The edge function must verify the caller is a team admin. It does this
 *   by validating the JWT and checking team_members.role. If we forwarded a
 *   service-role key, the edge function would skip the membership check.
 *
 * @param request - Incoming POST request
 * @returns Proxied response from the edge function
 */
export async function POST(request: Request): Promise<NextResponse> {
  // ── Auth: verify caller has a valid session ────────────────────────────────

  // WHY authenticate here before proxying:
  //   The edge function validates the JWT too, but adding an auth check at the
  //   proxy layer provides defense in depth and returns a consistent 401 shape
  //   before consuming the request body or making a network call.
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    );
  }

  // ── Parse body ─────────────────────────────────────────────────────────────

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      { status: 400 },
    );
  }

  // ── Read live access_token from the cookie-backed session ────────────────

  // WHY: browser users authenticate via HttpOnly cookies (not Authorization
  // headers). We extract the access_token from the cookie-backed session and
  // forward it to the edge function so teams-invite can call auth.getUser()
  // with real user context. Falling back to the anon key would cause
  // teams-invite to return 401 because anon has no user identity.
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'No active session.' },
      { status: 401 },
    );
  }

  const forwardAuth = `Bearer ${session.access_token}`;

  // ── Forward to edge function ───────────────────────────────────────────────

  // WHY NEXT_PUBLIC_SUPABASE_URL + /functions/v1/teams-invite:
  //   This is the standard Supabase edge function URL pattern. The edge function
  //   is deployed as part of the Supabase project and is only accessible via
  //   this URL with a valid JWT.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.error('[invitations/send] NEXT_PUBLIC_SUPABASE_URL is not set');
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Server configuration error' },
      { status: 500 },
    );
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/teams-invite`;

  let edgeResponse: Response;
  try {
    edgeResponse = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': forwardAuth,
      },
      body: JSON.stringify(body),
    });
  } catch (fetchError) {
    console.error('[invitations/send] Failed to reach edge function:', fetchError);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to reach invitation service' },
      { status: 500 },
    );
  }

  // ── Propagate edge function response ──────────────────────────────────────

  // WHY propagate all status codes (200, 400, 402, 403, 409, 429):
  //   The edge function's error shapes are part of the contract that the
  //   admin UI depends on. Wrapping them would lose structured error details
  //   (e.g., upgradeCta in 402). We pass them through as-is.
  let responseBody: unknown;
  try {
    responseBody = await edgeResponse.json();
  } catch {
    responseBody = { error: 'INTERNAL_ERROR', message: 'Invalid response from invitation service' };
  }

  return NextResponse.json(responseBody, { status: edgeResponse.status });
}
