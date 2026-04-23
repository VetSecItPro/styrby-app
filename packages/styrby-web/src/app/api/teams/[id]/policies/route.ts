/**
 * Team Policies API Route
 *
 * GET  /api/teams/[id]/policies — fetch the team's current policy settings
 * PATCH /api/teams/[id]/policies — update auto_approve_rules, blocked_tools,
 *                                   budget_per_seat_usd (owner/admin only)
 *
 * WHY a dedicated /policies endpoint rather than PATCH /api/teams/[id]:
 *   Policy edits are a higher-stakes governance action than team-name changes.
 *   Separating them gives us a clean audit-log target, a distinct rate-limit
 *   bucket, and lets us add field-level Zod validation without complicating
 *   the general team PATCH schema.
 *
 * WHY audit_log on every mutation:
 *   Policy changes affect every member's tool access. SOC2 CC6.2 (Logical and
 *   Physical Access Controls) requires audit trails for access-policy modifications.
 *   We record before + after values so diffs are reconstructable.
 *
 * @auth Required - Supabase Auth JWT via cookie (must be team owner or admin)
 * @rateLimit 30 requests per minute (standard bucket)
 *
 * @module api/teams/[id]/policies
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import {
  PatchTeamPolicyBodySchema,
  TeamPolicySettingsSchema,
  TEAM_ADMIN_AUDIT_ACTIONS,
} from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Shape of the teams table row we read/write for policy fields.
 *
 * WHY auto_approve_rules/blocked_tools as unknown[]:
 *   Supabase returns jsonb columns as unknown[]. We validate through Zod before
 *   using so the type is intentionally loose here.
 */
interface TeamPolicyRow {
  id: string;
  auto_approve_rules: unknown;
  blocked_tools: unknown;
  budget_per_seat_usd: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Verifies the caller is an authenticated member of the team and returns
 * their role. Returns null if the caller is not a member.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - Caller user ID
 * @param teamId - Team being accessed
 * @returns The caller's role, or null if not a member
 */
async function getCallerRole(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  teamId: string,
): Promise<'owner' | 'admin' | 'member' | null> {
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  if (!membership) return null;
  const role = membership.role as string;
  if (role === 'owner' || role === 'admin' || role === 'member') return role;
  return 'member';
}

// ============================================================================
// GET /api/teams/[id]/policies
// ============================================================================

/**
 * GET /api/teams/[id]/policies
 *
 * Returns the team's current editable policy settings (auto_approve_rules,
 * blocked_tools, budget_per_seat_usd). Accessible to all team members.
 *
 * @auth Required - Supabase Auth JWT via cookie (any team member)
 *
 * @returns 200 {
 *   policies: {
 *     auto_approve_rules: string[],
 *     blocked_tools: string[],
 *     budget_per_seat_usd: number | null
 *   }
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Not a member of this team' }
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to fetch team policies' }
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext,
) {
  try {
    const { id: teamId } = await context.params;
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const callerRole = await getCallerRole(supabase, user.id, teamId);
    if (!callerRole) {
      return NextResponse.json({ error: 'Not a member of this team' }, { status: 403 });
    }

    // RLS will gate access — only fetch the policy columns we expose.
    // SEC-API-004: Explicit column list avoids leaking future columns.
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('id, auto_approve_rules, blocked_tools, budget_per_seat_usd')
      .eq('id', teamId)
      .single() as { data: TeamPolicyRow | null; error: unknown };

    if (teamError || !team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Normalise jsonb arrays from Supabase (may be null or non-array).
    const policies = TeamPolicySettingsSchema.parse({
      auto_approve_rules: Array.isArray(team.auto_approve_rules) ? team.auto_approve_rules : [],
      blocked_tools: Array.isArray(team.blocked_tools) ? team.blocked_tools : [],
      budget_per_seat_usd: team.budget_per_seat_usd ?? null,
    });

    return NextResponse.json({ policies });
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('[policies GET]', isDev ? err : err instanceof Error ? err.message : 'Unknown');
    return NextResponse.json({ error: 'Failed to fetch team policies' }, { status: 500 });
  }
}

// ============================================================================
// PATCH /api/teams/[id]/policies
// ============================================================================

/**
 * PATCH /api/teams/[id]/policies
 *
 * Updates the team's policy settings. Owner or admin access required.
 * All fields are optional — send only the fields you want to change.
 * Every successful mutation is recorded in audit_log with before/after values.
 *
 * @auth Required - Supabase Auth JWT via cookie (must be owner or admin)
 * @rateLimit 30 requests per minute
 *
 * @body {
 *   auto_approve_rules?: string[],
 *   blocked_tools?: string[],
 *   budget_per_seat_usd?: number | null
 * }
 *
 * @returns 200 {
 *   policies: {
 *     auto_approve_rules: string[],
 *     blocked_tools: string[],
 *     budget_per_seat_usd: number | null
 *   }
 * }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Not a member, or insufficient role
 * @error 404 { error: 'Team not found' }
 * @error 500 { error: 'Failed to update team policies' }
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
) {
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'team-policies');
  if (!allowed) return rateLimitResponse(retryAfter!);

  try {
    const { id: teamId } = await context.params;
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only owner or admin can edit policies.
    const callerRole = await getCallerRole(supabase, user.id, teamId);
    if (!callerRole) {
      return NextResponse.json({ error: 'Not a member of this team' }, { status: 403 });
    }
    if (callerRole === 'member') {
      return NextResponse.json(
        { error: 'Only team owners and admins can edit policies' },
        { status: 403 },
      );
    }

    // Validate request body.
    const rawBody = await request.json();
    const parseResult = PatchTeamPolicyBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 },
      );
    }

    const patch = parseResult.data;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    // Fetch current values for audit_log before-state.
    const { data: currentTeam, error: fetchError } = await supabase
      .from('teams')
      .select('id, auto_approve_rules, blocked_tools, budget_per_seat_usd')
      .eq('id', teamId)
      .single() as { data: TeamPolicyRow | null; error: unknown };

    if (fetchError || !currentTeam) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Build the update payload (only changed fields).
    const updatePayload: Record<string, unknown> = {};
    if (patch.auto_approve_rules !== undefined) updatePayload.auto_approve_rules = patch.auto_approve_rules;
    if (patch.blocked_tools !== undefined) updatePayload.blocked_tools = patch.blocked_tools;
    if (patch.budget_per_seat_usd !== undefined) updatePayload.budget_per_seat_usd = patch.budget_per_seat_usd;

    // Apply the update.
    const { data: updatedTeam, error: updateError } = await supabase
      .from('teams')
      .update(updatePayload)
      .eq('id', teamId)
      .select('id, auto_approve_rules, blocked_tools, budget_per_seat_usd')
      .single() as { data: TeamPolicyRow | null; error: unknown };

    if (updateError || !updatedTeam) {
      console.error('[policies PATCH] update failed:', updateError);
      return NextResponse.json({ error: 'Failed to update team policies' }, { status: 500 });
    }

    // Write audit log.
    // WHY we fire-and-forget the audit_log insert: a logging failure must not
    // roll back a policy change that succeeded. The audit is for compliance;
    // the operation itself is already committed.
    supabase
      .from('audit_log')
      .insert({
        user_id: user.id,
        action: TEAM_ADMIN_AUDIT_ACTIONS.POLICY_UPDATED,
        resource_type: 'team',
        resource_id: teamId,
        metadata: {
          before: {
            auto_approve_rules: currentTeam.auto_approve_rules,
            blocked_tools: currentTeam.blocked_tools,
            budget_per_seat_usd: currentTeam.budget_per_seat_usd,
          },
          after: updatePayload,
          changed_by_role: callerRole,
        },
      })
      .then(({ error: auditError }) => {
        if (auditError) {
          // Non-fatal: log but do not reject
          console.error('[policies PATCH] audit_log insert failed:', auditError.message);
        }
      });

    const policies = TeamPolicySettingsSchema.parse({
      auto_approve_rules: Array.isArray(updatedTeam.auto_approve_rules) ? updatedTeam.auto_approve_rules : [],
      blocked_tools: Array.isArray(updatedTeam.blocked_tools) ? updatedTeam.blocked_tools : [],
      budget_per_seat_usd: updatedTeam.budget_per_seat_usd ?? null,
    });

    return NextResponse.json({ policies });
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('[policies PATCH]', isDev ? err : err instanceof Error ? err.message : 'Unknown');
    return NextResponse.json({ error: 'Failed to update team policies' }, { status: 500 });
  }
}
