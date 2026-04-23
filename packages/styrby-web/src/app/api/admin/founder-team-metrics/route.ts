/**
 * Founder Team Metrics API
 *
 * GET /api/admin/founder-team-metrics
 *
 * Returns aggregated team-tier business metrics for the founder dashboard:
 *   - Total number of teams
 *   - Average team size (member count)
 *   - Number of teams with member churn in the last 30 days
 *   - Churn rate per team (rolling 30d)
 *   - Per-team breakdown (name, member count, owner tier, churn flag)
 *
 * WHY separate from /api/admin/founder-metrics:
 *   The existing founder-metrics route aggregates solo-user metrics (MRR,
 *   funnel, LTV). Team metrics are a distinct Phase 2.3 surface. Keeping them
 *   separate allows the founder dashboard to load them independently and avoids
 *   bloating the already-complex founder-metrics payload.
 *
 * WHY service-role for DB queries:
 *   Team metrics aggregate data across ALL teams and ALL users. Supabase RLS is
 *   user-scoped — it cannot cross user boundaries. We use createAdminClient()
 *   (service role) only after verifying the is_admin gate at the API layer.
 *
 * WHY is_admin gate (not VITE_FOUNDER_USER_IDS):
 *   The is_admin column on profiles is set via service role only (no RLS UPDATE
 *   policy for users). This is the same pattern as founder-metrics and is more
 *   robust than environment-variable allowlists which can drift across deploys.
 *
 * @auth Required - Supabase Auth JWT via cookie (is_admin = true)
 * @rateLimit 10 requests per minute (sensitive bucket)
 *
 * @returns 200 {@link FounderTeamMetrics}
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 *
 * @module api/admin/founder-team-metrics
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import type { FounderTeamMetrics, FounderTeamSummary } from '@styrby/shared';

// ============================================================================
// DB row types (internal, not exported)
// ============================================================================

/** Raw team row from admin client. */
interface TeamDbRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

/** team_members aggregation row. */
interface MemberCountRow {
  team_id: string;
  count: number;
}

/** Subscription row for owner tier. */
interface SubscriptionRow {
  user_id: string;
  tier: string;
}

/** audit_log row for churn detection. */
interface AuditChurnRow {
  resource_id: string;
}

// ============================================================================
// Route handler
// ============================================================================

export async function GET(request: NextRequest) {
  // Rate limit first, before any DB call.
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.sensitive, 'founder-team-metrics');
  if (!allowed) return rateLimitResponse(retryAfter!);

  // Auth gate: must be a signed-in user.
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Admin gate: must have is_admin = true in profiles.
  const adminStatus = await isAdmin(user.id);
  if (!adminStatus) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const adminDb = createAdminClient();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // ── Fetch all data in parallel ──────────────────────────────────────────
    // WHY Promise.all: each query is independent; serial would multiply p99.
    const [teamsResult, membersResult, subsResult, churnResult] = await Promise.all([
      // All teams
      adminDb
        .from('teams')
        .select('id, name, owner_id, created_at')
        .order('created_at', { ascending: false }),

      // Member count per team (via team_members)
      adminDb
        .from('team_members')
        .select('team_id'),

      // Owner subscription tiers (for tier labelling)
      adminDb
        .from('subscriptions')
        .select('user_id, tier')
        .eq('status', 'active'),

      // Teams that had a member-removal audit event in the last 30d.
      // WHY audit_log not team_members deletions: deleted rows are gone.
      // The audit_log entry written by DELETE /api/teams/[id]/members/[userId]
      // is the only durable record of historical membership churn.
      adminDb
        .from('audit_log')
        .select('resource_id')
        .eq('action', 'team.member.removed')
        .gte('created_at', thirtyDaysAgo.toISOString()),
    ]);

    const teams = (teamsResult.data ?? []) as TeamDbRow[];
    const memberRows = (membersResult.data ?? []) as { team_id: string }[];
    const subs = (subsResult.data ?? []) as SubscriptionRow[];
    const churnRows = (churnResult.data ?? []) as AuditChurnRow[];

    // ── Build lookup maps ───────────────────────────────────────────────────

    /** member count per team_id */
    const memberCountByTeam: Record<string, number> = {};
    for (const row of memberRows) {
      memberCountByTeam[row.team_id] = (memberCountByTeam[row.team_id] ?? 0) + 1;
    }

    /** active subscription tier per user_id */
    const tierByOwner: Record<string, string> = {};
    for (const sub of subs) {
      tierByOwner[sub.user_id] = sub.tier;
    }

    /** set of team_ids that had churn in the last 30d */
    const churnedTeamIds = new Set(churnRows.map((r) => r.resource_id));

    // ── Compute per-team summaries ──────────────────────────────────────────

    const teamSummaries: FounderTeamSummary[] = teams.map((team) => ({
      team_id: team.id,
      team_name: team.name,
      member_count: memberCountByTeam[team.id] ?? 0,
      owner_tier: tierByOwner[team.owner_id] ?? 'free',
      had_churn_30d: churnedTeamIds.has(team.id),
      created_at: team.created_at,
    }));

    // ── Aggregate metrics ───────────────────────────────────────────────────

    const teamCount = teams.length;
    const totalMembers = teamSummaries.reduce((sum, t) => sum + t.member_count, 0);
    const avgTeamSize = teamCount > 0 ? totalMembers / teamCount : 0;
    const churnedTeams30d = teamSummaries.filter((t) => t.had_churn_30d).length;
    const churnRatePerTeam30d = teamCount > 0 ? churnedTeams30d / teamCount : null;

    const metrics: FounderTeamMetrics = {
      team_count: teamCount,
      avg_team_size: Math.round(avgTeamSize * 100) / 100, // 2 decimal places
      churned_teams_30d: churnedTeams30d,
      churn_rate_per_team_30d: churnRatePerTeam30d,
      teams: teamSummaries,
      computed_at: now.toISOString(),
    };

    return NextResponse.json(metrics);
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[founder-team-metrics] Error:', isDev ? err : message);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: isDev ? message : 'Metrics computation failed' },
      { status: 500 },
    );
  }
}
