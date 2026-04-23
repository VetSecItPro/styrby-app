/**
 * Team Cost Analytics API Route
 *
 * GET /api/teams/[id]/costs
 *
 * Returns:
 *   1. Per-member cost summary (total spend, tokens) for the requested period.
 *   2. Per-agent daily stacked-bar data for the same period.
 *   3. MTD vs seat-budget projection from v_team_cost_projection.
 *
 * WHY a dedicated /costs route (not inline on GET /api/teams/[id]):
 *   Cost data is large (N days × M agents × K members) and fetched separately
 *   from team metadata (name, members list). Separating the routes lets the
 *   team dashboard lazy-load cost charts without blocking the initial page render.
 *
 * WHY service-role (createAdminClient):
 *   mv_team_cost_summary and v_team_cost_projection live outside RLS.
 *   The route enforces the membership gate itself (verified via the RPC functions
 *   which are SECURITY DEFINER + membership-checked). Using createAdminClient
 *   here is safe because the route is auth-gated and the RPCs enforce membership.
 *
 * WHY not calling the RPC from the browser:
 *   The team cost dashboard page is a Next.js server component. Fetching via
 *   this API route (self-call pattern, same as /api/admin/founder-metrics) keeps
 *   the service-role key server-side only.
 *
 * @auth   Required - Supabase Auth JWT via cookie (must be team member)
 * @rateLimit 30 requests per minute
 *
 * @queryParam days  Number of days to look back (7 | 30 | 90). Default: 30.
 *
 * @returns 200 {
 *   members: Array<{
 *     userId: string,
 *     displayName: string,
 *     email: string,
 *     totalCostUsd: number,
 *     totalInputTokens: number,
 *     totalOutputTokens: number
 *   }>,
 *   dailyByAgent: Array<{
 *     date: string,        // 'YYYY-MM-DD'
 *     agentType: string,
 *     totalCostUsd: number,
 *     totalInputTokens: number,
 *     totalOutputTokens: number
 *   }>,
 *   projection: {
 *     teamName: string,
 *     billingTier: string,
 *     activeSeats: number,
 *     seatBudgetUsd: number,
 *     mtdSpendUsd: number,
 *     projectedMtdUsd: number,
 *     daysElapsed: number,
 *     daysInMonth: number
 *   } | null
 * }
 *
 * @error 400 { error: 'INVALID_DAYS', message: string }
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Not a member of this team' }
 * @error 404 { error: 'Team not found' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Per-member cost summary row (as returned by get_team_cost_summary_v2 RPC). */
interface MemberCostRpcRow {
  user_id: string;
  display_name: string | null;
  email: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

/** Per-agent daily row (as returned by get_team_cost_by_agent RPC). */
interface AgentCostRpcRow {
  record_date: string;
  agent_type: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

/** Projection view row (from v_team_cost_projection). */
interface ProjectionRow {
  team_id: string;
  team_name: string;
  billing_tier: string;
  active_seats: number;
  seat_budget_usd: number;
  mtd_spend_usd: number;
  days_elapsed: number;
  days_in_month: number;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /api/teams/[id]/costs.
 *
 * Fetches per-member cost summary, per-agent daily data, and MTD projection
 * from the mv_team_cost_summary MV (via SECURITY DEFINER RPCs).
 *
 * @param request - Incoming Next.js request (reads ?days query param)
 * @param context - Route context providing team [id]
 * @returns JSON cost analytics response
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  // Rate limit: 30 req/min per user (same bucket as team read operations)
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.default, 'team-costs');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const { id: teamId } = await context.params;

    // Parse ?days query param (default 30, allowed: 7 | 30 | 90)
    const url = new URL(request.url);
    const daysRaw = Number(url.searchParams.get('days'));
    const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;

    // Auth gate — use user-scoped client so we get the caller's identity
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify team membership using the user-scoped client (RLS enforces this).
    // WHY: Even though the cost queries below use the admin client, we verify
    // membership here as a first-class auth check for a cleaner 403 response.
    const { data: memberRow, error: memberError } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (memberError) {
      console.error('[team-costs] membership check error:', memberError.message);
      return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to verify team membership' }, { status: 500 });
    }

    if (!memberRow) {
      return NextResponse.json({ error: 'Not a member of this team' }, { status: 403 });
    }

    // Compute date range
    const endDate = new Date().toISOString().split('T')[0] as string;
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - days);
    const startDate = startDateObj.toISOString().split('T')[0] as string;

    // Use admin client for MV-backed RPC calls (service-role bypasses RLS on MV)
    const adminClient = await createAdminClient();

    // Fetch all three datasets in parallel to minimise TTFB.
    // WHY parallel: member summary, daily agent breakdown, and projection are
    // independent queries. Serial fetches would triple server render latency.
    const [membersResult, agentResult, projectionResult] = await Promise.all([
      // 1. Per-member totals via SECURITY DEFINER RPC (membership re-checked in DB)
      adminClient.rpc('get_team_cost_summary_v2', {
        p_team_id: teamId,
        p_start_date: startDate,
        p_end_date: endDate,
      }),

      // 2. Per-agent daily rows for the stacked bar chart
      adminClient.rpc('get_team_cost_by_agent', {
        p_team_id: teamId,
        p_start_date: startDate,
        p_end_date: endDate,
      }),

      // 3. MTD vs seat-budget projection (view is service-role readable)
      adminClient
        .from('v_team_cost_projection')
        .select('team_id, team_name, billing_tier, active_seats, seat_budget_usd, mtd_spend_usd, days_elapsed, days_in_month')
        .eq('team_id', teamId)
        .maybeSingle(),
    ]);

    // Handle errors non-fatally where possible
    if (membersResult.error) {
      const msg = membersResult.error.message ?? '';
      // WHY: The RPC itself re-checks membership. A privilege error here means
      // we passed the API-level check but the DB disagreed (race condition or
      // the RPC function is not yet deployed). Distinguish the two for clarity.
      if (msg.includes('insufficient_privilege') || msg.includes('Not a member')) {
        return NextResponse.json({ error: 'Not a member of this team' }, { status: 403 });
      }
      console.error('[team-costs] get_team_cost_summary_v2 error:', msg);
      return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch member costs' }, { status: 500 });
    }

    // Agent data failure is non-fatal — return what we have without chart data
    const agentRows: AgentCostRpcRow[] = (agentResult.data as AgentCostRpcRow[] | null) ?? [];
    if (agentResult.error) {
      console.error('[team-costs] get_team_cost_by_agent error:', agentResult.error.message);
      // Proceed with empty agent data so member table still renders
    }

    // Map RPC rows to camelCase response shape
    const members = ((membersResult.data as MemberCostRpcRow[]) ?? []).map((row) => ({
      userId: row.user_id,
      displayName: row.display_name ?? row.email,
      email: row.email,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      totalInputTokens: Number(row.total_input_tokens) || 0,
      totalOutputTokens: Number(row.total_output_tokens) || 0,
    }));

    const dailyByAgent = agentRows.map((row) => ({
      date: row.record_date,
      agentType: row.agent_type,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      totalInputTokens: Number(row.total_input_tokens) || 0,
      totalOutputTokens: Number(row.total_output_tokens) || 0,
    }));

    // Build projection shape; null when view returns nothing (fresh team, no billing)
    let projection: {
      teamName: string;
      billingTier: string;
      activeSeats: number;
      seatBudgetUsd: number;
      mtdSpendUsd: number;
      projectedMtdUsd: number;
      daysElapsed: number;
      daysInMonth: number;
    } | null = null;

    if (!projectionResult.error && projectionResult.data) {
      const p = projectionResult.data as ProjectionRow;
      const daysElapsed = p.days_elapsed || 1;
      const daysInMonth = p.days_in_month || 30;
      const mtd = Number(p.mtd_spend_usd) || 0;

      // WHY: Projected MTD = (MTD spend so far) / (days elapsed) × (days in month).
      // This is a simple linear projection — accurate enough for a planning tool.
      // A more sophisticated approach would weight recent days higher (exponential
      // smoothing), but that complexity is not justified at this stage.
      const projectedMtdUsd = daysElapsed > 0
        ? (mtd / daysElapsed) * daysInMonth
        : 0;

      projection = {
        teamName: p.team_name,
        billingTier: p.billing_tier,
        activeSeats: p.active_seats,
        seatBudgetUsd: Number(p.seat_budget_usd) || 0,
        mtdSpendUsd: mtd,
        projectedMtdUsd,
        daysElapsed,
        daysInMonth,
      };
    }

    return NextResponse.json({ members, dailyByAgent, projection });
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[team-costs] unhandled error:',
      isDev ? err : err instanceof Error ? err.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch team costs' }, { status: 500 });
  }
}
