/**
 * POST /api/invitations/[invitationId]/revoke
 *
 * Revokes a pending team invitation. Sets status to 'revoked' and records the
 * revoker. The seat-delta trigger (trg_team_invitations_seat_delta from
 * migration 030) automatically decrements teams.active_seats when status
 * transitions from 'pending' — no manual decrement needed here.
 *
 * WHY UPDATE (not DELETE):
 *   Deleting the row would lose the audit trail showing this invitation was
 *   ever sent. We keep the row and set status='revoked' so admins can see
 *   the full invitation history. The DB trigger handles active_seats.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *   Caller must be an admin or owner of the team.
 *
 * @path /api/invitations/[invitationId]/revoke
 *   invitationId: UUID of the team_invitations row
 *
 * @body (empty — no body required)
 *
 * @returns 200 { success: true, status: 'revoked' }
 *
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';

/**
 * Revokes a team invitation.
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

  // WHY service-role client: avoids complex RLS join. Admin check is done
  // at application layer in Step 3.
  const adminClient = createAdminClient();

  const { data: invitation, error: fetchError } = await adminClient
    .from('team_invitations')
    .select('id, team_id, status, email')
    .eq('id', invitationId)
    .single();

  if (fetchError || !invitation) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Invitation not found' },
      { status: 404 },
    );
  }

  // ── Step 3: Verify caller is admin or owner ────────────────────────────────

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
      { error: 'FORBIDDEN', message: 'Only team owners and admins can revoke invitations' },
      { status: 403 },
    );
  }

  // ── Step 3b: Guard against revoking non-pending invitations ──────────────

  // WHY: revoking an already-accepted invitation would confuse the audit trail
  // (the member would still be a team_members row) and corrupt the seat count
  // (the trigger decrements active_seats on 'pending' -> 'revoked' only, but
  // an 'accepted' -> 'revoked' transition has no defined trigger path in
  // migration 030). Returning 409 keeps the state machine coherent.
  if (invitation.status !== 'pending') {
    return NextResponse.json(
      {
        error: 'INVALID_STATE',
        message: `Cannot revoke an invitation with status '${invitation.status}'.`,
      },
      { status: 409 },
    );
  }

  // ── Step 4: UPDATE status to 'revoked' ────────────────────────────────────

  // WHY UPDATE not DELETE: see module docblock.
  // The trg_team_invitations_seat_delta trigger (migration 030) fires AFTER UPDATE
  // and decrements teams.active_seats when status changes from 'pending'.
  const { data: updated, error: updateError } = await adminClient
    .from('team_invitations')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
    })
    .eq('id', invitationId)
    .select('id, status')
    .single();

  if (updateError || !updated) {
    console.error('[invitations/revoke] Failed to update invitation status:', updateError);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to revoke invitation' },
      { status: 500 },
    );
  }

  // ── Step 5: Write audit_log ───────────────────────────────────────────────

  const { error: auditError } = await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: 'team_invite_revoked',
    resource_type: 'team_invitation',
    resource_id: invitation.id,
    metadata: {
      team_id: invitation.team_id,
      invited_email: invitation.email,
    },
  });

  if (auditError) {
    console.error('[invitations/revoke] Failed to write audit_log:', auditError);
  }

  return NextResponse.json({
    success: true,
    status: 'revoked',
  });
}
