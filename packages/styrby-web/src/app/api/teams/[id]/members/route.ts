/**
 * Team Members API Route
 *
 * Handles team member invitations. Creating members is done via invitation
 * (not direct addition) to support email-based invites for users who may
 * not yet have accounts.
 *
 * POST /api/teams/[id]/members - Invite a new member
 *
 * @rateLimit 30 requests per minute
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { randomBytes } from 'crypto';
import { sendEmail } from '@/lib/resend';
import * as React from 'react';
import TeamInvitationEmail from '@/emails/team-invitation';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for inviting a team member.
 */
const InviteMemberSchema = z.object({
  email: z
    .string()
    .email('Please enter a valid email address'),
  role: z
    .enum(['admin', 'member'])
    .default('member'),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<{ id: string }>;
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The authenticated user's ID
 * @returns The user's tier ID (defaults to 'free' if no subscription found)
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<TierId> {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return (subscription?.tier as TierId) || 'free';
}

/**
 * Generates a secure random token for invitation links.
 *
 * WHY 32 bytes: Provides 256 bits of entropy, making it computationally
 * infeasible to guess. URL-safe base64 encoding for use in links.
 *
 * @returns A 43-character URL-safe token
 */
function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// POST /api/teams/[id]/members
// ---------------------------------------------------------------------------

/**
 * POST /api/teams/[id]/members
 *
 * Invites a new member to the team via email. Creates a pending invitation
 * record and sends an invitation email with a secure token link.
 *
 * @auth Required - Supabase Auth JWT via cookie (must be team owner or admin)
 *
 * @body {
 *   email: string,
 *   role?: 'admin' | 'member'  // defaults to 'member'
 * }
 *
 * @returns 201 {
 *   invitation: {
 *     id: string,
 *     email: string,
 *     role: 'admin' | 'member',
 *     expires_at: string,
 *     created_at: string
 *   }
 * }
 *
 * @error 400 { error: string } - Validation failure, already member, pending invite
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not authorized to invite, team limit reached
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to invite member' }
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'team-invite');
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
    const parseResult = InviteMemberSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const { email, role } = parseResult.data;

    // Fetch team and verify user has permission to invite
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('id, name, owner_id')
      .eq('id', teamId)
      .single();

    if (teamError || !team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const { data: membership } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .single();

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return NextResponse.json(
        { error: 'Only team owners and admins can invite members' },
        { status: 403 }
      );
    }

    // Check team size limit
    const tier = await getUserTier(supabase, team.owner_id);
    const teamLimit = TIERS[tier]?.limits.teamMembers ?? 1;

    const { count: memberCount } = await supabase
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId);

    const { count: pendingCount } = await supabase
      .from('team_invitations')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .eq('status', 'pending');

    const totalMembers = (memberCount || 0) + (pendingCount || 0);

    if (totalMembers >= teamLimit) {
      return NextResponse.json(
        {
          error: `Team has reached the maximum of ${teamLimit} members for the ${tier} plan. ` +
            'The team owner can upgrade to add more members.',
        },
        { status: 403 }
      );
    }

    // Check if user is already a member by querying team members with their emails.
    // WHY: We use the get_team_members RPC function which joins auth.users to get
    // member emails, allowing us to check if the invitee is already on the team.
    const { data: teamMembers } = await supabase
      .rpc('get_team_members', { p_team_id: teamId });

    const isAlreadyMember = (teamMembers || []).some(
      (m: { email: string }) => m.email.toLowerCase() === email.toLowerCase()
    );

    if (isAlreadyMember) {
      return NextResponse.json(
        { error: 'This user is already a member of the team' },
        { status: 400 }
      );
    }

    // Check for existing pending invitation
    const { data: existingInvite } = await supabase
      .from('team_invitations')
      .select('id')
      .eq('team_id', teamId)
      .eq('email', email.toLowerCase())
      .eq('status', 'pending')
      .single();

    if (existingInvite) {
      return NextResponse.json(
        { error: 'An invitation has already been sent to this email address' },
        { status: 400 }
      );
    }

    // Generate invitation token
    const token = generateInvitationToken();

    // Create invitation record
    const { data: invitation, error: inviteError } = await supabase
      .from('team_invitations')
      .insert({
        team_id: teamId,
        email: email.toLowerCase(),
        invited_by: user.id,
        role,
        token,
      })
      .select('id, email, role, created_at, expires_at')
      .single();

    if (inviteError) {
      console.error('Failed to create invitation:', inviteError.message);
      return NextResponse.json(
        { error: 'Failed to create invitation' },
        { status: 500 }
      );
    }

    // Get inviter's profile for email
    const { data: inviterProfile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    // Send invitation email
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://styrbyapp.com'}/invite/${token}`;

    await sendEmail({
      to: email,
      subject: `You've been invited to join ${team.name} on Styrby`,
      react: React.createElement(TeamInvitationEmail, {
        teamName: team.name,
        inviterName: inviterProfile?.display_name || user.email || 'A team member',
        inviterEmail: user.email || '',
        role,
        inviteUrl,
        expiresAt: invitation.expires_at,
      }),
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Team invite POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to invite member' },
      { status: 500 }
    );
  }
}
