/**
 * Team Detail API Route
 *
 * Provides operations for a specific team. All operations require the user
 * to be a member of the team. Modification operations require admin+ role.
 *
 * GET    /api/teams/[id] - Get team details with members
 * PATCH  /api/teams/[id] - Update team name/description (owner only)
 * DELETE /api/teams/[id] - Delete team (owner only)
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
 * Schema for updating team details.
 * All fields are optional to support partial updates.
 */
const UpdateTeamSchema = z.object({
  name: z
    .string()
    .min(1, 'Team name is required')
    .max(100, 'Team name must be 100 characters or less')
    .optional(),
  description: z
    .string()
    .max(500, 'Description must be 500 characters or less')
    .nullable()
    .optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<{ id: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/teams/[id]
// ---------------------------------------------------------------------------

/**
 * GET /api/teams/[id]
 *
 * Returns team details including all members. Only accessible to team members.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   team: {
 *     id: string,
 *     name: string,
 *     description: string | null,
 *     owner_id: string,
 *     created_at: string,
 *     updated_at: string
 *   },
 *   members: Array<{
 *     id: string,
 *     user_id: string,
 *     role: 'owner' | 'admin' | 'member',
 *     display_name: string | null,
 *     email: string,
 *     avatar_url: string | null,
 *     joined_at: string
 *   }>,
 *   pendingInvitations: Array<{
 *     id: string,
 *     email: string,
 *     role: 'admin' | 'member',
 *     created_at: string,
 *     expires_at: string
 *   }>,
 *   currentUserRole: 'owner' | 'admin' | 'member'
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Not a member of this team' }
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to fetch team' }
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext
) {
  try {
    const { id: teamId } = await context.params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch team (RLS ensures user is a member)
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('id', teamId)
      .single();

    if (teamError) {
      if (teamError.code === 'PGRST116') {
        // Check if team exists at all (user might not be a member)
        return NextResponse.json(
          { error: 'Team not found or you are not a member' },
          { status: 404 }
        );
      }
      console.error('Failed to fetch team:', teamError.message);
      return NextResponse.json(
        { error: 'Failed to fetch team' },
        { status: 500 }
      );
    }

    // Fetch members using the get_team_members function
    const { data: membersData, error: membersError } = await supabase
      .rpc('get_team_members', { p_team_id: teamId });

    if (membersError) {
      console.error('Failed to fetch team members:', membersError.message);
      return NextResponse.json(
        { error: 'Failed to fetch team members' },
        { status: 500 }
      );
    }

    // Map members to expected format
    const members = (membersData || []).map((m: {
      member_id: string;
      user_id: string;
      role: string;
      display_name: string | null;
      email: string;
      avatar_url: string | null;
      joined_at: string;
    }) => ({
      id: m.member_id,
      user_id: m.user_id,
      role: m.role,
      display_name: m.display_name,
      email: m.email,
      avatar_url: m.avatar_url,
      joined_at: m.joined_at,
    }));

    // Get current user's role
    const currentMember = members.find((m: { user_id: string }) => m.user_id === user.id);
    const currentUserRole = currentMember?.role || 'member';

    // Fetch pending invitations (only for owner/admin)
    let pendingInvitations: Array<{
      id: string;
      email: string;
      role: string;
      created_at: string;
      expires_at: string;
    }> = [];

    if (currentUserRole === 'owner' || currentUserRole === 'admin') {
      const { data: invites } = await supabase
        .from('team_invitations')
        .select('id, email, role, created_at, expires_at')
        .eq('team_id', teamId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      pendingInvitations = invites || [];
    }

    return NextResponse.json({
      team,
      members,
      pendingInvitations,
      currentUserRole,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch team' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/teams/[id]
// ---------------------------------------------------------------------------

/**
 * PATCH /api/teams/[id]
 *
 * Updates team details. Only the team owner can update.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   name?: string,
 *   description?: string | null
 * }
 *
 * @returns 200 { team: Team }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Only the team owner can update team settings' }
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to update team' }
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'teams');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: teamId } = await context.params;
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
    const parseResult = UpdateTeamSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check if user is the owner (RLS will also enforce this)
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
        { error: 'Only the team owner can update team settings' },
        { status: 403 }
      );
    }

    // Build update object
    const updateFields = Object.fromEntries(
      Object.entries(parseResult.data).filter(([, value]) => value !== undefined)
    );

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    // Update team
    const { data: updatedTeam, error: updateError } = await supabase
      .from('teams')
      .update(updateFields)
      .eq('id', teamId)
      .select()
      .single();

    if (updateError) {
      console.error('Failed to update team:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to update team' },
        { status: 500 }
      );
    }

    return NextResponse.json({ team: updatedTeam });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team PATCH error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to update team' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/teams/[id]
// ---------------------------------------------------------------------------

/**
 * DELETE /api/teams/[id]
 *
 * Deletes a team and all associated data. Only the team owner can delete.
 * This action is irreversible - all team members, invitations, and
 * team session associations will be removed.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 { success: true }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Only the team owner can delete the team' }
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to delete team' }
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.sensitive, 'teams-delete');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: teamId } = await context.params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is the owner (RLS will also enforce this)
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
        { error: 'Only the team owner can delete the team' },
        { status: 403 }
      );
    }

    // Delete team (CASCADE will remove members, invitations)
    // Sessions will have team_id set to NULL (ON DELETE SET NULL)
    const { error: deleteError } = await supabase
      .from('teams')
      .delete()
      .eq('id', teamId);

    if (deleteError) {
      console.error('Failed to delete team:', deleteError.message);
      return NextResponse.json(
        { error: 'Failed to delete team' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to delete team' },
      { status: 500 }
    );
  }
}
