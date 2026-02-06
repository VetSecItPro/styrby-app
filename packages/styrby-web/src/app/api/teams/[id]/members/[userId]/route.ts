/**
 * Team Member Management API Route
 *
 * Handles operations on individual team members: updating roles and removing
 * members from a team.
 *
 * PATCH  /api/teams/[id]/members/[userId] - Update member role
 * DELETE /api/teams/[id]/members/[userId] - Remove member from team
 *
 * @rateLimit 30 requests per minute
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for updating a member's role.
 *
 * WHY no 'owner' option: Ownership transfer is a separate, more complex
 * operation that we don't support via this endpoint. Teams have exactly
 * one owner at all times.
 */
const UpdateMemberSchema = z.object({
  role: z.enum(['admin', 'member'], {
    errorMap: () => ({ message: 'Role must be "admin" or "member"' }),
  }),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<{ id: string; userId: string }>;
};

// ---------------------------------------------------------------------------
// PATCH /api/teams/[id]/members/[userId]
// ---------------------------------------------------------------------------

/**
 * PATCH /api/teams/[id]/members/[userId]
 *
 * Updates a team member's role. Only the team owner can change roles.
 * Admins cannot modify roles (prevents privilege escalation).
 *
 * @auth Required - Supabase Auth JWT via cookie (must be team owner)
 *
 * @body {
 *   role: 'admin' | 'member'
 * }
 *
 * @returns 200 {
 *   member: {
 *     id: string,
 *     user_id: string,
 *     role: string,
 *     updated_at: string
 *   }
 * }
 *
 * @error 400 { error: string } - Validation failure, self-modification
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not authorized
 * @error 404 { error: 'Member not found' }
 * @error 500 { error: 'Failed to update member' }
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'team-members');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: teamId, userId: targetUserId } = await context.params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = UpdateMemberSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const { role: newRole } = parseResult.data;

    // Check if user is the team owner
    const { data: team } = await supabase
      .from('teams')
      .select('owner_id')
      .eq('id', teamId)
      .single();

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    if (team.owner_id !== user.id) {
      return NextResponse.json(
        { error: 'Only the team owner can change member roles' },
        { status: 403 }
      );
    }

    // Cannot modify your own role
    if (targetUserId === user.id) {
      return NextResponse.json(
        { error: 'You cannot change your own role' },
        { status: 400 }
      );
    }

    // Find the target member
    const { data: targetMember } = await supabase
      .from('team_members')
      .select('id, role')
      .eq('team_id', teamId)
      .eq('user_id', targetUserId)
      .single();

    if (!targetMember) {
      return NextResponse.json(
        { error: 'Member not found in this team' },
        { status: 404 }
      );
    }

    // Cannot modify the owner's role (they're in team_members with role 'owner')
    if (targetMember.role === 'owner') {
      return NextResponse.json(
        { error: 'Cannot modify the team owner\'s role' },
        { status: 400 }
      );
    }

    // Update the member's role
    const { data: updatedMember, error: updateError } = await supabase
      .from('team_members')
      .update({ role: newRole })
      .eq('id', targetMember.id)
      .select('id, user_id, role, updated_at')
      .single();

    if (updateError) {
      console.error('Failed to update member:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to update member' },
        { status: 500 }
      );
    }

    return NextResponse.json({ member: updatedMember });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team member PATCH error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to update member' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/teams/[id]/members/[userId]
// ---------------------------------------------------------------------------

/**
 * DELETE /api/teams/[id]/members/[userId]
 *
 * Removes a member from the team. Allowed for:
 * - Team owner: Can remove anyone
 * - Team admin: Can remove members (not other admins or owner)
 * - Any member: Can remove themselves (leave team)
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Cannot remove owner
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not authorized
 * @error 404 { error: 'Member not found' }
 * @error 500 { error: 'Failed to remove member' }
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'team-members');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: teamId, userId: targetUserId } = await context.params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get team to check ownership
    const { data: team } = await supabase
      .from('teams')
      .select('owner_id')
      .eq('id', teamId)
      .single();

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Cannot remove the team owner
    if (targetUserId === team.owner_id) {
      return NextResponse.json(
        { error: 'The team owner cannot be removed. Transfer ownership or delete the team instead.' },
        { status: 400 }
      );
    }

    // Get current user's membership
    const { data: currentMembership } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .single();

    if (!currentMembership) {
      return NextResponse.json(
        { error: 'You are not a member of this team' },
        { status: 403 }
      );
    }

    // Get target member
    const { data: targetMember } = await supabase
      .from('team_members')
      .select('id, role')
      .eq('team_id', teamId)
      .eq('user_id', targetUserId)
      .single();

    if (!targetMember) {
      return NextResponse.json(
        { error: 'Member not found in this team' },
        { status: 404 }
      );
    }

    // Check permissions:
    // 1. Anyone can remove themselves
    // 2. Owner can remove anyone
    // 3. Admin can remove members (not other admins)
    const isSelf = targetUserId === user.id;
    const isOwner = currentMembership.role === 'owner';
    const isAdmin = currentMembership.role === 'admin';
    const targetIsAdmin = targetMember.role === 'admin';

    if (!isSelf && !isOwner && !(isAdmin && !targetIsAdmin)) {
      return NextResponse.json(
        { error: 'You do not have permission to remove this member' },
        { status: 403 }
      );
    }

    // Remove the member
    const { error: deleteError } = await supabase
      .from('team_members')
      .delete()
      .eq('id', targetMember.id);

    if (deleteError) {
      console.error('Failed to remove member:', deleteError.message);
      return NextResponse.json(
        { error: 'Failed to remove member' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team member DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to remove member' },
      { status: 500 }
    );
  }
}
