/**
 * POST /api/invitations/[invitationId]/resend
 *
 * Re-sends an existing pending invitation by generating a new token,
 * replacing the stored token_hash, extending the expiry, and re-sending
 * the email. Updates the existing row in-place (no new row created).
 *
 * WHY update in-place (not create a new row):
 *   Creating a new row would orphan the old invitation row and potentially
 *   leave two rows for the same (team_id, email) pair, violating the unique
 *   constraint. Updating in-place preserves row identity and audit continuity
 *   while rotating the token secret.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *   Caller must be an admin or owner of the team.
 *
 * @rateLimit Reuses checkInviteRateLimit (counts resends against the 20/24h cap)
 *
 * @path /api/invitations/[invitationId]/resend
 *   invitationId: UUID of the team_invitations row
 *
 * @body (empty — no body required)
 *
 * @returns 200 { success: true, invitation_id: string, expires_at: string }
 *
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 429 { error: 'RATE_LIMITED', resetAt: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { sendTeamInvitationEmail } from '@/lib/resend';
import { checkInviteRateLimit } from '@styrby/shared';

// ============================================================================
// Constants
// ============================================================================

/** Invitation TTL on resend — same as original (24h). */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Crypto helpers
// ============================================================================

/**
 * Generates a new 96-hex-char invitation token.
 *
 * WHY two entropy sources (same rationale as edge function):
 *   UUID v4 provides 122 bits; an additional 32 random bytes provides 256 bits.
 *   Total: ~378 bits of entropy, making brute-force infeasible.
 *
 * @returns Raw token (never stored)
 */
function generateInviteToken(): string {
  const uuidPart = crypto.randomUUID().replace(/-/g, '');
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomPart = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return uuidPart + randomPart;
}

/**
 * Computes SHA-256 hex digest.
 *
 * @param input - String to hash
 * @returns 64-char lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Route handler
// ============================================================================

/**
 * Re-sends a team invitation with a fresh token.
 *
 * @param request - Incoming POST request
 * @param ctx - Next.js route context with invitationId param
 * @returns JSON response
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ invitationId: string }> },
): Promise<NextResponse> {
  const { invitationId } = await ctx.params;

  // ── Step 1: Auth ───────────────────────────────────────────────────────────

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    );
  }

  // ── Step 2: Fetch invitation row ───────────────────────────────────────────

  // WHY service-role client for invitation lookup:
  //   RLS on team_invitations grants SELECT to team admins by joining team_members.
  //   Using service_role here avoids a complex RLS join. We enforce the admin
  //   permission check in Step 3 below at the application layer.
  const adminClient = createAdminClient();

  const { data: invitation, error: fetchError } = await adminClient
    .from('team_invitations')
    .select('id, team_id, email, role, status, expires_at, token_hash, invited_by, teams(name), profiles(display_name, email)')
    .eq('id', invitationId)
    .single();

  if (fetchError || !invitation) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Invitation not found' },
      { status: 404 },
    );
  }

  // ── Step 3: Verify caller is admin or owner on the team ───────────────────

  const { data: membership, error: memberError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', invitation.team_id)
    .eq('user_id', user.id)
    .single();

  if (memberError || !membership) {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'You are not a member of this team' },
      { status: 403 },
    );
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Only team owners and admins can resend invitations' },
      { status: 403 },
    );
  }

  // ── Step 3b: Guard against resending non-pending invitations ─────────────

  // WHY: resending an accepted or revoked invitation is a no-op at best and
  // confusing to the invitee at worst (they receive a new link for an invite
  // that is already closed). We return 409 so the admin UI can show a clear
  // "this invitation is already accepted/revoked" message.
  if (invitation.status !== 'pending') {
    return NextResponse.json(
      {
        error: 'INVALID_STATE',
        message: `Cannot resend an invitation with status '${invitation.status}'.`,
      },
      { status: 409 },
    );
  }

  // ── Step 4: Rate limit check (resends count against the 24h cap) ──────────

  // WHY resends count against the same cap:
  //   Without this, an admin could bypass the invite cap by rapidly resending
  //   the same invitation to cycle tokens and enumerate recipient states.
  let rlResult: { allowed: boolean; remaining: number; resetAt: number };
  try {
    rlResult = await checkInviteRateLimit(invitation.team_id);
  } catch (rlError) {
    // WHY fail-open on Redis error: same reasoning as edge function.
    // Rate limiting is a safeguard, not a hard dependency.
    console.error('[invitations/resend] Rate limit check failed, allowing:', rlError);
    rlResult = { allowed: true, remaining: 20, resetAt: Date.now() + 86400_000 };
  }

  if (!rlResult.allowed) {
    const retryAfter = Math.ceil((rlResult.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many invitation emails. Try again later.', resetAt: rlResult.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    );
  }

  // ── Step 5: Generate new token + hash ─────────────────────────────────────

  const newRawToken = generateInviteToken();
  const newTokenHash = await sha256Hex(newRawToken);
  const newExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  // ── Step 6: Update invitation row in-place ────────────────────────────────

  // WHY update in-place: see module docblock.
  // We update token_hash + expires_at; status remains 'pending'.
  // The old token_hash is overwritten — old links sent in previous emails
  // are immediately invalidated.
  const { data: updatedInvitation, error: updateError } = await adminClient
    .from('team_invitations')
    .update({
      token_hash: newTokenHash,
      expires_at: newExpiresAt,
    })
    .eq('id', invitationId)
    .select('id, expires_at')
    .single();

  if (updateError || !updatedInvitation) {
    console.error('[invitations/resend] Failed to update token_hash:', updateError);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to rotate invitation token' },
      { status: 500 },
    );
  }

  // ── Step 7: Re-send email ──────────────────────────────────────────────────

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://styrbyapp.com';
  const inviteUrl = `${appUrl}/invite/${newRawToken}`;

  // Extract team name and inviter details from the join
  // WHY nested object typing: Supabase join returns nested objects when using
  // the `teams(name)` syntax. TypeScript doesn't infer this type automatically.
  const teamName = (invitation.teams as { name?: string } | null)?.name ?? 'your team';
  const inviterProfile = invitation.profiles as { display_name?: string | null; email?: string | null } | null;
  const inviterName = inviterProfile?.display_name ?? inviterProfile?.email ?? 'A team admin';
  const inviterEmail = inviterProfile?.email ?? '';

  const emailResult = await sendTeamInvitationEmail({
    email: invitation.email,
    teamName,
    inviterName,
    inviterEmail,
    role: invitation.role as 'admin' | 'member' | 'viewer',
    inviteUrl,
    expiresAt: updatedInvitation.expires_at,
  });

  if (!emailResult.success) {
    // WHY warn-and-continue: token is already rotated. The admin can see the
    // email failed in the audit log and try again.
    console.error('[invitations/resend] Email send failed:', emailResult.error);
  }

  // ── Step 8: Write audit_log ───────────────────────────────────────────────

  const { error: auditError } = await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: 'team_invite_resent',
    resource_type: 'team_invitation',
    resource_id: invitation.id,
    metadata: {
      team_id: invitation.team_id,
      invited_email: invitation.email,
      role: invitation.role,
      email_sent: emailResult.success,
    },
  });

  if (auditError) {
    console.error('[invitations/resend] Failed to write audit_log:', auditError);
  }

  return NextResponse.json({
    success: true,
    invitation_id: updatedInvitation.id,
    expires_at: updatedInvitation.expires_at,
  });
}
