/**
 * Admin route guard for Next.js middleware.
 *
 * Provides `requireSiteAdmin` — the single enforced gate for all /admin and
 * /api/admin/* paths. Called from the top-level middleware after the Supabase
 * session is refreshed, before any route handler logic runs.
 *
 * Threat model (from spec §2):
 *   - Admin route discovery by unauthenticated scan → 404 (not 401/403).
 *   - Authenticated non-admin fishing for admin surface → same 404.
 *   - Database error during admin check → fail-closed (404).
 *
 * WHY 404 instead of 403/401:
 *   Returning 401 or 403 confirms that the route exists, which reveals attack
 *   surface to scanners. A 404 is indistinguishable from the route not existing
 *   at all. This is the "security through obscurity — as a defence layer"
 *   pattern recommended by OWASP A01:2021 (Broken Access Control):
 *   "Do not expose admin endpoints in a predictable location or return
 *   distinguishable error codes that confirm their existence."
 *   SOC 2 CC6.1 also requires that access control failures do not leak
 *   information about protected resources to unauthorized subjects.
 *
 * WHY fail-closed on DB error:
 *   An availability failure in the authorization path must default to DENY,
 *   not ALLOW. A database outage must never become an admin-access bypass.
 *   This aligns with OWASP A01 and NIST SP 800-53 AC-3 (Access Enforcement):
 *   "The information system enforces approved authorizations … in accordance
 *   with applicable policy and deny-all, permit-by-exception principle."
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// ─── Sentinel response ────────────────────────────────────────────────────────

/**
 * A 404 response with no body — the deny-by-obscurity response.
 *
 * WHY null body: Any response body distinguishes a real 404 from a security
 * gate. We return exactly nothing so a scanner cannot fingerprint the gate.
 *
 * WHY Cache-Control: no-store: A CDN (Cloudflare, Vercel Edge Network, or a
 * reverse proxy) must never cache a denial response. If a 404 denial were
 * cached at the edge, a later legitimate admin request from the same IP/path
 * would receive the cached 404 — effectively locking the admin out. Setting
 * `no-store` prevents the response from being stored in any cache tier.
 * `max-age=0` is belt-and-suspenders: older proxy implementations may ignore
 * `no-store` alone; `max-age=0` additionally tells them the response is
 * already stale and must be revalidated. SOC 2 CC6.1 — access control
 * responses must not persist beyond the request.
 */
function denyResponse(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

// ─── Guard ────────────────────────────────────────────────────────────────────

/**
 * Verifies that the authenticated user making `request` is a site admin.
 *
 * The check queries the `site_admins` table using the user's own session
 * (anon key + RLS). The RLS policy on site_admins allows `SELECT` only for
 * `auth.uid() = user_id`, meaning:
 *   - A non-admin user gets 0 rows (RLS hides all other rows).
 *   - An admin user gets exactly 1 row (their own record).
 *
 * This means a successful non-empty query result is sufficient proof of
 * admin status — no further permission checks are required.
 *
 * @param supabase - A Supabase client initialised with the user's session
 *   cookies (anon key, not service role). The caller (middleware) is
 *   responsible for creating this client from the incoming request's cookies
 *   so that RLS evaluates as the requesting user.
 * @param _request - The incoming Next.js request. Reserved for future use
 *   (e.g., audit-log IP attribution); currently unused by this function.
 * @returns `null` if the user is a confirmed site admin (allow the request
 *   to proceed). A `NextResponse` with status 404 for any other outcome:
 *   unauthenticated, non-admin, or query failure.
 *
 * @security 404-on-deny: See module-level JSDoc — 404 is intentional and
 *   required by the threat model. Do NOT change to 401/403 without updating
 *   the threat model and spec §2. SOC 2 CC6.1 + OWASP A01:2021 apply.
 *
 * @security fail-closed: Any error (network, DB timeout, RLS misconfiguration)
 *   returns 404. This is intentional: NIST SP 800-53 AC-3 deny-by-default.
 *
 * @example
 * // In middleware, after updateSession():
 * const adminDeny = await requireSiteAdmin(supabase, request);
 * if (adminDeny) return adminDeny; // 404 → stop
 * // else: user is confirmed admin, continue to route handler
 */
export async function requireSiteAdmin(
  supabase: SupabaseClient,
  _request: NextRequest
): Promise<NextResponse | null> {
  // Step 1: Confirm there is an authenticated user at all.
  // WHY getUser() vs. session: getUser() performs a network round-trip to
  // validate the JWT with Supabase Auth, rather than trusting a locally
  // decoded cookie. This prevents JWT-forgery attacks where an attacker
  // crafts a cookie with a spoofed user_id.
  let userId: string | null = null;
  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      // Unauthenticated — deny with 404 (do not reveal the route exists).
      return denyResponse();
    }

    userId = user.id;
  } catch {
    // Network or unexpected error fetching the user — fail-closed.
    return denyResponse();
  }

  // Step 2: Check the site_admins table using the user's own session.
  // RLS policy: users can only SELECT their own row (WHERE user_id = auth.uid()).
  // A row present → admin. No row → not admin.
  try {
    const { data, error } = await supabase
      .from('site_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      // DB error (connection failure, RLS error, etc.) — fail-closed.
      return denyResponse();
    }

    if (!data) {
      // No matching row → user is not in site_admins → deny.
      return denyResponse();
    }

    // Row found → user is a confirmed site admin → allow through.
    return null;
  } catch {
    // Unexpected query error — fail-closed.
    return denyResponse();
  }
}
