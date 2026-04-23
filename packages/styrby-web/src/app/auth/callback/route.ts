/**
 * Auth callback handler for OAuth and magic link flows.
 *
 * Exchanges the auth code for a session, then:
 *   1. Sends welcome email on first login (all providers)
 *   2. For Google OAuth: extracts the `hd` (hosted domain) claim and:
 *      a. Auto-enrolls into any matching team with sso_domain (if seat cap allows)
 *      b. Rejects (redirects to /login?error=sso_required) if the user is a
 *         member of a team with require_sso=true AND they authenticated via
 *         password/OTP (non-Google provider)
 *
 * Security notes:
 *   - `hd` claim is ONLY trusted from the Supabase session metadata set by
 *     Supabase Auth after OAuth token exchange. We never trust a client-supplied
 *     hd value. Supabase Auth verifies the Google ID token before populating
 *     user_metadata.
 *   - require_sso enforcement: checked for ALL providers so password-auth users
 *     in SSO-only teams are redirected even if they bypass the UI.
 *   - auto_sso_enroll is called with the service_role client (bypasses RLS) but
 *     the DB function itself re-verifies domain match under an advisory lock.
 *
 * @module app/auth/callback
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { sendWelcomeEmail } from '@/lib/resend';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of auto-enroll retry attempts when the DB function returns
 * 'lock_contention'. Each retry waits for a brief period.
 *
 * WHY: Under concurrent signup load, pg_try_advisory_xact_lock may fail on
 * the first attempt. We retry up to 3 times with 200ms back-off.
 */
const SSO_ENROLL_MAX_RETRIES = 3;
const SSO_ENROLL_RETRY_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates a redirect path to prevent open redirect attacks.
 *
 * WHY: Without validation, an attacker could craft a URL like
 * `/auth/callback?code=...&redirect=https://evil.com` and after
 * successful auth the victim would be sent to the attacker's site.
 *
 * @param path - The redirect path from the query string
 * @returns A safe, relative redirect path (defaults to /dashboard)
 */
function sanitizeRedirect(path: string | null): string {
  if (!path) return '/dashboard';

  // Must start with a single slash (relative path)
  // Must NOT contain `//` (protocol-relative URL or double-slash tricks)
  // Must NOT contain backslashes (some browsers normalize `\` to `/`)
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\')) {
    return '/dashboard';
  }

  return path;
}

/**
 * Extracts the verified `hd` (hosted domain) claim from Google OAuth user metadata.
 *
 * WHY: The `hd` claim is set by Google in the ID token for Workspace accounts.
 * Supabase Auth verifies the Google ID token before writing user_metadata, so
 * this value is trustworthy server-side. We normalize to lowercase to match
 * DB storage.
 *
 * @param userMetadata - The user_metadata object from the Supabase session
 * @returns The lowercase domain string or null if not a Google Workspace account
 */
function extractGoogleHdClaim(userMetadata: Record<string, unknown>): string | null {
  // Supabase stores the raw Google user info in user_metadata.
  // Google includes `hd` for Workspace accounts; personal accounts omit it.
  const rawHd = userMetadata?.hd;
  if (typeof rawHd !== 'string' || !rawHd.trim()) return null;
  return rawHd.trim().toLowerCase();
}

/**
 * Attempts SSO auto-enroll for a user into a matching team, with retry on lock contention.
 *
 * WHY retry: pg_try_advisory_xact_lock returns false (not blocking) when the lock
 * is held. Under burst signup load (20 users from same domain simultaneously),
 * most will contend. Retrying allows sequential enrollment up to seat cap.
 *
 * @param adminClient - Supabase admin client (service_role, bypasses RLS)
 * @param userId - The newly authenticated user's UUID
 * @param teamId - Target team UUID
 * @param hdClaim - The verified Google hd claim (lowercase)
 * @param userEmail - User's email address for audit log
 * @returns The enroll result JSON or null on unexpected error
 */
async function autoSsoEnrollWithRetry(
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string,
  teamId: string,
  hdClaim: string,
  userEmail: string,
): Promise<{ enrolled: boolean; reason?: string } | null> {
  for (let attempt = 0; attempt < SSO_ENROLL_MAX_RETRIES; attempt++) {
    const { data, error } = await adminClient.rpc('auto_sso_enroll', {
      p_user_id: userId,
      p_team_id: teamId,
      p_hd_claim: hdClaim,
      p_user_email: userEmail,
    });

    if (error) {
      console.error('[auth/callback] auto_sso_enroll RPC error:', error.message);
      return null;
    }

    const result = data as { enrolled: boolean; reason?: string };

    if (result.reason !== 'lock_contention') {
      return result;
    }

    // Lock contention: wait and retry
    if (attempt < SSO_ENROLL_MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, SSO_ENROLL_RETRY_DELAY_MS));
    }
  }

  // Exhausted retries - non-fatal, user can be enrolled manually
  console.warn('[auth/callback] SSO enroll failed after retries due to lock contention', {
    userId,
    teamId,
    hdClaim,
  });
  return { enrolled: false, reason: 'lock_contention_max_retries' };
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

/**
 * GET /auth/callback
 *
 * Handles the redirect from Supabase after OAuth or magic-link auth.
 *
 * Flow:
 *   1. Exchange code for session
 *   2. If new user: send welcome email
 *   3. If Google OAuth with hd claim: auto-enroll into matching SSO teams
 *   4. For all providers: check require_sso policy; reject if violated
 *   5. Redirect to intended destination
 *
 * @param request - Incoming GET request with `code` and `redirect` search params
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirect = sanitizeRedirect(searchParams.get('redirect'));

  if (code) {
    const supabase = await createClient();
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

    if (sessionError || !sessionData.user) {
      console.error('[auth/callback] code exchange failed:', sessionError?.message);
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }

    const user = sessionData.user;

    // -------------------------------------------------------------------------
    // Step 1: Welcome email for new users
    // -------------------------------------------------------------------------
    const createdAt = new Date(user.created_at);
    const isNewUser = Date.now() - createdAt.getTime() < 60_000;

    if (isNewUser && user.email) {
      const displayName =
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.email.split('@')[0];

      sendWelcomeEmail({ email: user.email, displayName }).catch((err) => {
        console.error('[auth/callback] failed to send welcome email:', err);
      });
    }

    // -------------------------------------------------------------------------
    // Step 2: Google SSO auto-enroll
    //
    // WHY only for Google provider: GitHub and magic-link users don't carry an
    // `hd` claim. We check the provider from session data to gate this block.
    // Supabase stores the provider in app_metadata.provider.
    // -------------------------------------------------------------------------
    const provider = user.app_metadata?.provider;
    const hdClaim = provider === 'google'
      ? extractGoogleHdClaim(user.user_metadata ?? {})
      : null;

    if (hdClaim && user.email) {
      try {
        const adminClient = createAdminClient();

        // Find all teams with this SSO domain
        const { data: matchingTeams, error: teamQueryError } = await adminClient
          .from('teams')
          .select('id, seat_cap, active_seats, require_sso')
          .eq('sso_domain', hdClaim);

        if (teamQueryError) {
          console.error('[auth/callback] failed to query SSO teams:', teamQueryError.message);
        } else if (matchingTeams && matchingTeams.length > 0) {
          // Enroll into each matching team (most installations have 1)
          const enrollResults = await Promise.allSettled(
            matchingTeams.map((team: { id: string; seat_cap: number | null; active_seats: number; require_sso: boolean }) =>
              autoSsoEnrollWithRetry(adminClient, user.id, team.id, hdClaim, user.email!),
            ),
          );

          // Log any enrollment failures for observability (non-fatal)
          enrollResults.forEach((result, i) => {
            const team = matchingTeams[i];
            if (result.status === 'rejected') {
              console.error('[auth/callback] SSO enroll promise rejected for team', team.id, result.reason);
            } else if (result.value && !result.value.enrolled && result.value.reason !== 'already_member') {
              console.warn('[auth/callback] SSO enroll returned non-enrolled for team', team.id, result.value.reason);
            }
          });
        }
      } catch (err) {
        // SSO auto-enroll failure is non-fatal: the user still authenticated
        // successfully. They will need to be manually invited if seat cap hit.
        console.error('[auth/callback] SSO auto-enroll error:', err instanceof Error ? err.message : err);
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: require_sso enforcement
    //
    // SECURITY CRITICAL: If a team has require_sso=true, members who did NOT
    // use Google SSO must be rejected here. This prevents users from using
    // password/magic-link to access teams that mandate SSO.
    //
    // WHY check ALL providers (not just non-Google): Even a Google user on a
    // different account than the approved domain could be a pre-existing
    // password-auth member. The check is: does the user belong to any
    // require_sso=true team AND are they NOT authenticated via Google with the
    // correct hd claim?
    // -------------------------------------------------------------------------
    try {
      const adminClient = createAdminClient();

      const { data: ssoPolicy } = await adminClient.rpc('get_team_sso_policy', {
        p_user_id: user.id,
      });

      if (ssoPolicy?.policies && Array.isArray(ssoPolicy.policies)) {
        for (const policy of ssoPolicy.policies as Array<{
          team_id: string;
          sso_domain: string | null;
          require_sso: boolean;
          role: string;
        }>) {
          if (!policy.require_sso) continue;

          // Team requires SSO. Verify user authenticated via Google with matching hd.
          const domainMatches =
            provider === 'google' && hdClaim && policy.sso_domain &&
            hdClaim === policy.sso_domain.toLowerCase();

          if (!domainMatches) {
            // Log the rejection for audit trail
            await adminClient.from('audit_log').insert({
              user_id: user.id,
              action: 'team_sso_rejected',
              metadata: {
                team_id: policy.team_id,
                reason: 'require_sso_password_auth',
                provider: provider ?? 'unknown',
                hd_claim: hdClaim ?? null,
                expected_domain: policy.sso_domain,
                email: user.email,
              },
            });

            // Redirect to login with SSO-required error
            // WHY encode team name in error param: The login page shows a user-friendly
            // message explaining they must use Google SSO, not a generic error.
            return NextResponse.redirect(
              `${origin}/login?error=sso_required&team_id=${encodeURIComponent(policy.team_id)}`,
            );
          }
        }
      }
    } catch (err) {
      // require_sso check failure: fail open (allow the login) but log it.
      // WHY fail open: A bug in the check should not lock users out of the app
      // entirely. The team admin can revoke sessions manually if needed.
      console.error('[auth/callback] require_sso policy check error:', err instanceof Error ? err.message : err);
    }

    // -------------------------------------------------------------------------
    // Redirect to intended destination
    // -------------------------------------------------------------------------
    return NextResponse.redirect(`${origin}${redirect}`);
  }

  // No code in query params - auth initiation failed
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
