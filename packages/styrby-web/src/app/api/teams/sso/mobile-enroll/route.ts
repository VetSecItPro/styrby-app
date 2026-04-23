/**
 * POST /api/teams/sso/mobile-enroll
 *
 * Called by the mobile app after Google OAuth sign-in to trigger SSO
 * auto-enroll logic. The web auth/callback route handles this automatically
 * for web logins, but mobile OAuth does not route through Next.js.
 *
 * Security model:
 *   - Caller must supply a valid Supabase JWT (Authorization: Bearer <token>)
 *   - We verify the session server-side and extract the hd claim from
 *     user_metadata (set by Supabase Auth from the Google ID token - NOT
 *     from the request body)
 *   - The hd claim from the request body is IGNORED to prevent injection
 *   - auto_sso_enroll DB function re-verifies domain match under advisory lock
 *
 * @module app/api/teams/sso/mobile-enroll
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { createServerClient } from '@supabase/ssr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase client that reads the JWT from the Authorization header
 * (for mobile API calls that pass the token directly, not via cookie).
 *
 * WHY: Mobile apps use Bearer token auth, not cookie-based auth.
 * We extract the JWT, verify it via getUser(), and trust the user_metadata
 * that Supabase Auth populates from the Google OAuth token exchange.
 *
 * @param token - The raw JWT from the Authorization header
 */
function createMobileAuthClient(token: string) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {},
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );
}

/**
 * Extracts the verified `hd` (hosted domain) claim from Google OAuth user metadata.
 * Returns null for non-Google or personal accounts.
 *
 * WHY: Supabase Auth populates user_metadata from the Google ID token which
 * it verifies server-side. This value cannot be forged by the client.
 *
 * @param userMetadata - The user_metadata from the verified Supabase session
 * @returns The lowercase domain string or null
 */
function extractHdClaim(userMetadata: Record<string, unknown>): string | null {
  const rawHd = userMetadata?.hd;
  if (typeof rawHd !== 'string' || !rawHd.trim()) return null;
  return rawHd.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/teams/sso/mobile-enroll
 *
 * Triggers SSO auto-enroll for the calling user after Google sign-in on mobile.
 *
 * @auth Required - Bearer token (Supabase Auth JWT from Google OAuth session)
 *
 * @body {} (empty - all data derived from the verified session)
 *
 * @returns 200 {
 *   teams_enrolled: Array<{ team_id: string, team_name: string }>,
 *   teams_rejected: Array<{ team_id: string, reason: string }>
 * }
 * @error 401 { error: 'Unauthorized' }
 * @error 400 { error: 'Google SSO session required' }
 * @error 500 { error: 'Enrollment check failed' }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Extract JWT from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);

  try {
    // Verify the session and get the user
    const mobileClient = createMobileAuthClient(token);
    const {
      data: { user },
      error: authError,
    } = await mobileClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Extract hd claim from verified user_metadata
    // WHY NOT from request body: See security model above.
    const provider = user.app_metadata?.provider;
    if (provider !== 'google') {
      return NextResponse.json(
        { error: 'Google SSO session required', enrolled: false },
        { status: 400 },
      );
    }

    const hdClaim = extractHdClaim(user.user_metadata ?? {});
    if (!hdClaim) {
      // Personal Google account - not a Workspace domain; no team to enroll into
      return NextResponse.json({
        teams_enrolled: [],
        teams_rejected: [],
        message: 'No Workspace domain in Google session (personal account)',
      });
    }

    const adminClient = createAdminClient();

    // Find matching teams
    const { data: matchingTeams, error: teamError } = await adminClient
      .from('teams')
      .select('id, name, seat_cap, active_seats')
      .eq('sso_domain', hdClaim);

    if (teamError) {
      console.error('[mobile-enroll] team query error:', teamError.message);
      return NextResponse.json({ error: 'Enrollment check failed' }, { status: 500 });
    }

    if (!matchingTeams || matchingTeams.length === 0) {
      return NextResponse.json({ teams_enrolled: [], teams_rejected: [] });
    }

    // Enroll into each matching team
    const enrolled: Array<{ team_id: string; team_name: string }> = [];
    const rejected: Array<{ team_id: string; reason: string }> = [];

    for (const team of matchingTeams as Array<{ id: string; name: string; seat_cap: number | null; active_seats: number }>) {
      const { data: result, error: enrollError } = await adminClient.rpc('auto_sso_enroll', {
        p_user_id: user.id,
        p_team_id: team.id,
        p_hd_claim: hdClaim,
        p_user_email: user.email ?? '',
      });

      if (enrollError) {
        console.error('[mobile-enroll] auto_sso_enroll RPC error:', enrollError.message);
        rejected.push({ team_id: team.id, reason: 'rpc_error' });
        continue;
      }

      const enrollResult = result as { enrolled: boolean; reason?: string };
      if (enrollResult.enrolled) {
        enrolled.push({ team_id: team.id, team_name: team.name });
      } else if (enrollResult.reason !== 'already_member') {
        rejected.push({ team_id: team.id, reason: enrollResult.reason ?? 'unknown' });
      }
    }

    return NextResponse.json({ teams_enrolled: enrolled, teams_rejected: rejected });
  } catch (err) {
    console.error('[mobile-enroll] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Enrollment check failed' }, { status: 500 });
  }
}
