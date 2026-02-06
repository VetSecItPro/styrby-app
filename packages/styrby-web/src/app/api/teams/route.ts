/**
 * Teams API Route
 *
 * Provides CRUD operations for team management. Team creation is restricted
 * to Power tier subscribers. Team size limits are enforced at creation and
 * member invitation time.
 *
 * GET  /api/teams - List user's teams with member counts
 * POST /api/teams - Create a new team (Power tier only)
 *
 * @rateLimit 30 requests per minute
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for creating a new team.
 *
 * WHY name length limits: Team names are displayed in UI headers and need
 * to fit reasonably. 1-100 chars allows flexibility while preventing abuse.
 */
const CreateTeamSchema = z.object({
  name: z
    .string()
    .min(1, 'Team name is required')
    .max(100, 'Team name must be 100 characters or less'),
  description: z
    .string()
    .max(500, 'Description must be 500 characters or less')
    .optional(),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * WHY: Team creation is restricted to Power tier. We must verify the user's
 * current subscription status before allowing team operations.
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
 * Checks if a tier has team features enabled.
 *
 * WHY: Only Power tier includes team collaboration. Pro and Free users must
 * upgrade to access team features.
 *
 * @param tier - The user's subscription tier
 * @returns True if the tier includes team features
 */
function tierHasTeamFeatures(tier: TierId): boolean {
  return tier === 'power';
}

// ---------------------------------------------------------------------------
// GET /api/teams
// ---------------------------------------------------------------------------

/**
 * GET /api/teams
 *
 * Lists all teams the authenticated user is a member of, including their
 * role and team metadata.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   teams: Array<{
 *     id: string,
 *     name: string,
 *     description: string | null,
 *     owner_id: string,
 *     role: 'owner' | 'admin' | 'member',
 *     member_count: number,
 *     joined_at: string,
 *     created_at: string
 *   }>,
 *   tier: TierId,
 *   teamLimit: number,
 *   canCreateTeam: boolean
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch teams' }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch teams using the get_user_teams function and tier in parallel
    const [teamsResult, tier] = await Promise.all([
      supabase.rpc('get_user_teams'),
      getUserTier(supabase, user.id),
    ]);

    if (teamsResult.error) {
      console.error('Failed to fetch teams:', teamsResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch teams' },
        { status: 500 }
      );
    }

    // Also fetch full team data for created_at
    const teamIds = (teamsResult.data || []).map((t: { team_id: string }) => t.team_id);
    let teamsWithDates: Record<string, string> = {};

    if (teamIds.length > 0) {
      const { data: fullTeams } = await supabase
        .from('teams')
        .select('id, created_at')
        .in('id', teamIds);

      teamsWithDates = (fullTeams || []).reduce((acc: Record<string, string>, t: { id: string; created_at: string }) => {
        acc[t.id] = t.created_at;
        return acc;
      }, {});
    }

    // Map the RPC result to the expected format
    const teams = (teamsResult.data || []).map((t: {
      team_id: string;
      team_name: string;
      team_description: string | null;
      owner_id: string;
      role: string;
      member_count: number;
      joined_at: string;
    }) => ({
      id: t.team_id,
      name: t.team_name,
      description: t.team_description,
      owner_id: t.owner_id,
      role: t.role,
      member_count: t.member_count,
      joined_at: t.joined_at,
      created_at: teamsWithDates[t.team_id] || t.joined_at,
    }));

    // WHY: We return canCreateTeam to help the UI show/hide the create button
    // and display appropriate upgrade prompts.
    const canCreateTeam = tierHasTeamFeatures(tier);
    const teamLimit = TIERS[tier]?.limits.teamMembers ?? 1;

    return NextResponse.json({
      teams,
      tier,
      teamLimit,
      canCreateTeam,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Teams GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch teams' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/teams
// ---------------------------------------------------------------------------

/**
 * POST /api/teams
 *
 * Creates a new team. Only available for Power tier subscribers.
 * The authenticated user becomes the team owner.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   name: string,
 *   description?: string
 * }
 *
 * @returns 201 {
 *   team: {
 *     id: string,
 *     name: string,
 *     description: string | null,
 *     owner_id: string,
 *     created_at: string
 *   }
 * }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not Power tier
 * @error 500 { error: 'Failed to create team' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'teams');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
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
    const parseResult = CreateTeamSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier - only Power users can create teams
    const tier = await getUserTier(supabase, user.id);

    if (!tierHasTeamFeatures(tier)) {
      return NextResponse.json(
        {
          error: 'Team collaboration is only available on the Power plan. Upgrade to create and manage teams.',
        },
        { status: 403 }
      );
    }

    // Create the team
    // WHY: The trigger handle_new_team automatically adds the owner as a team member
    const { data: team, error: insertError } = await supabase
      .from('teams')
      .insert({
        name: parseResult.data.name,
        description: parseResult.data.description || null,
        owner_id: user.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create team:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create team' },
        { status: 500 }
      );
    }

    return NextResponse.json({ team }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Teams POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create team' },
      { status: 500 }
    );
  }
}
