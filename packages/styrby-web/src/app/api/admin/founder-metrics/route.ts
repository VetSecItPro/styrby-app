/**
 * Founder Ops Metrics API
 *
 * GET /api/admin/founder-metrics
 *
 * Returns aggregated business metrics for the founder ops dashboard:
 *   - MRR / ARR (sum of active subscription monthly values)
 *   - Churn rate (canceled in last 30d / active at start of period)
 *   - Per-cohort retention (30-day, 90-day active fractions)
 *   - Per-user LTV estimate (avg MRR x avg tenure months)
 *   - Tier mix (count per tier)
 *   - Agent usage distribution (session count per agent_type)
 *   - Per-agent error class histogram (from structured logs / audit_log)
 *   - Funnel: total users → onboarded → first-session → 7d-active → 30d-active
 *
 * WHY service-role for DB queries: Founder metrics aggregate data across ALL
 * users. Supabase RLS is user-scoped — it cannot be used for cross-user
 * aggregation from a client request. We use createAdminClient() (service role)
 * to bypass RLS and aggregate at the database level. The API layer enforces
 * the access gate (is_admin check) before any data is returned.
 *
 * WHY site_admins gate: The metrics include cohort data, agent distribution,
 * and per-tier counts that are commercially sensitive. Only the founder
 * (vetsecitpro@gmail.com, in site_admins table) should access this endpoint.
 *
 * @auth Required - Supabase Auth JWT via cookie (must be in site_admins table; verified via is_site_admin() RPC; migration 042 T3.5 cutover)
 * @rateLimit 10 requests per minute
 *
 * @returns 200 {@link FounderMetrics}
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
// Aliased imports keep the doc-style helper names readable inside
// `mrrUsdForSubscription` while pointing at the canonical price helpers.
import {
  calculateMonthlyCostCents as calculateMonthlyCostCentsHelper,
  calculateAnnualCostCents as calculateAnnualCostCentsHelper,
} from '@/lib/billing/polar-products';

// ============================================================================
// Types
// ============================================================================

/**
 * Tier mix count entry.
 */
interface TierCount {
  tier: string;
  count: number;
}

/**
 * Agent usage entry (sessions per agent).
 */
interface AgentUsage {
  agentType: string;
  sessionCount: number;
  totalCostUsd: number;
}

/**
 * Funnel step.
 */
interface FunnelStep {
  step: string;
  count: number;
  /** Percentage of the previous step. null for the first step. */
  conversionFromPrev: number | null;
}

/**
 * Cohort retention entry.
 */
interface CohortRetention {
  /** ISO month string (YYYY-MM) */
  cohortMonth: string;
  /** Number of users who signed up in this cohort. */
  cohortSize: number;
  /** Fraction still active at 30 days (0-1). */
  retention30d: number | null;
  /** Fraction still active at 90 days (0-1). */
  retention90d: number | null;
}

/**
 * Complete founder metrics payload.
 */
export interface FounderMetrics {
  /** Monthly Recurring Revenue in USD (sum of active subscription values). */
  mrrUsd: number;
  /** Annual Recurring Revenue = MRR * 12. */
  arrUsd: number;
  /**
   * 30-day churn rate: subscriptions that canceled in the last 30 days
   * divided by subscriptions that were active at the start of the period.
   */
  churnRate30d: number | null;
  /**
   * 90-day trailing churn rate.
   */
  churnRate90d: number | null;
  /**
   * Estimated average LTV in USD.
   * Computed as: (avg monthly subscription value) * (avg tenure in months).
   */
  avgLtvUsd: number | null;
  /** Count of active subscriptions per tier. */
  tierMix: TierCount[];
  /** Session count and total cost per agent type. */
  agentUsage: AgentUsage[];
  /**
   * Onboard-to-active funnel:
   *   total_users → onboarded → first_session → 7d_active → 30d_active
   */
  funnel: FunnelStep[];
  /**
   * Per-cohort retention curves (last 6 months).
   * WHY last 6 only: older cohorts have full retention data but the UI
   * only renders the trailing 6 months to keep the chart readable.
   */
  cohortRetention: CohortRetention[];
  /** ISO timestamp of when these metrics were computed. */
  computedAt: string;
}

// ============================================================================
// Tier MRR values
// ============================================================================

/**
 * Static fallback MRR-per-row for never-shipped legacy enum values. The DB
 * `subscription_tier` enum still permits these for historical rows; we keep
 * best-effort estimates so historical MRR is not silently zero.
 *
 * 'power' was REMOVED here when it was retired (migration 095) — it has zero
 * rows and is no longer a tier. Pro and Growth are NOT in this table — they're
 * computed from the canonical pricing helpers below to match what Polar charges.
 */
const LEGACY_TIER_MRR_USD: Record<string, number> = {
  free: 0,
  team: 19, // never-shipped per-seat (one row per seat = $19/row contribution)
  business: 39, // never-shipped per-seat
  enterprise: 0, // custom pricing — never in self-serve MRR
};

/**
 * Computes the MRR contribution (USD, integer) for a single active
 * subscription row.
 *
 * WHY route Pro/Growth through `calculateMonthlyCostCents`: it's the same
 * helper the pricing page uses, sandbox-validated to match Polar's actual
 * charges to the cent. Legacy tiers fall through to the static table.
 *
 * For annual billing, divides annual cost by 12 to express as a monthly
 * recurring number (this is the standard MRR convention).
 *
 * @param tier - subscription_tier enum value
 * @param isAnnual - whether the subscription is on the annual cycle
 * @param seats - per-Polar seat count (only meaningful for Growth; null for others)
 */
function mrrUsdForSubscription(
  tier: string,
  isAnnual: boolean,
  seats: number | null,
): number {
  if (tier === 'pro') {
    const monthlyCents = isAnnual
      ? Math.floor(calculateAnnualCostCentsHelper('pro', 1) / 12)
      : calculateMonthlyCostCentsHelper('pro', 1);
    return monthlyCents / 100;
  }
  if (tier === 'growth') {
    const effectiveSeats = seats ?? 3; // 3 = GROWTH_BASE_SEATS minimum
    const monthlyCents = isAnnual
      ? Math.floor(calculateAnnualCostCentsHelper('growth', effectiveSeats) / 12)
      : calculateMonthlyCostCentsHelper('growth', effectiveSeats);
    return monthlyCents / 100;
  }
  return LEGACY_TIER_MRR_USD[tier] ?? 0;
}

// ============================================================================
// Route handler
// ============================================================================

export async function GET(request: NextRequest) {
  // Rate limit first, before any DB call.
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'founder-metrics');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // Auth gate: must be a signed-in user.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Admin gate: must be in site_admins table (A-001; migration 042 T3.5 cutover).
  // WHY createAdminClient() for the admin check: isAdmin() uses createAdminClient
  // internally; the caller's RLS-scoped client cannot see other users' rows.
  // Service role bypasses RLS for the site_admins lookup only.
  const adminStatus = await isAdmin(user.id);
  if (!adminStatus) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── MFA gate — H42 Layer 1 ────────────────────────────────────────────────
  // OWASP A07:2021, SOC 2 CC6.1.
  try {
    await assertAdminMfa(user.id);
  } catch (err) {
    if (err instanceof AdminMfaRequiredError) {
      return NextResponse.json({ error: err.code }, { status: err.statusCode });
    }
    throw err;
  }

  try {
    const adminDb = createAdminClient();
    const now = new Date();
    const nowIso = now.toISOString();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Fetch all data in parallel to minimise latency.
    // WHY Promise.all: each query is independent; serial would triple the p99.
    const [
      activeSubsResult,
      canceledSubsResult,
      agentUsageResult,
      funnelResult,
      cohortResult,
    ] = await Promise.all([
      // Active subscriptions — for MRR + tier mix + LTV
      // WHY include `seats` and `is_annual`: MRR for Growth depends on the
      // per-row seat count (tiered seat-based pricing) and the billing
      // cycle. Without these, Growth subs would contribute $0 to MRR
      // (they'd fall through the LEGACY_TIER_MRR_USD lookup which has no
      // 'growth' entry).
      adminDb
        .from('subscriptions')
        .select('tier, status, created_at, user_id, seats, is_annual')
        .eq('status', 'active')
        // WHY exclude `%no_mrr%`: internal comp accounts (e.g. the founder's
        // admin grant, polar_subscription_id 'internal_admin_no_mrr') carry a
        // real tier for entitlement but contribute ZERO revenue. Counting them
        // inflates MRR/ARR and the tier mix with phantom customers. The
        // '_no_mrr' suffix is the explicit "not real revenue" marker — filter
        // on it so any future comp account is excluded automatically.
        .not('polar_subscription_id', 'ilike', '%no_mrr%'),

      // Canceled subscriptions — for churn rate (last 90 days)
      adminDb
        .from('subscriptions')
        .select('tier, status, updated_at')
        .eq('status', 'canceled')
        // BUG #50: apply the SAME `%no_mrr%` exclusion as the active query above.
        // The churn ratio divides canceled by (active + canceled); if a comp
        // '_no_mrr' account is ever canceled it would inflate BOTH the canceled
        // numerator and denominator while its active counterparts were excluded,
        // skewing the rate. Both sides of the ratio must use the same population.
        .not('polar_subscription_id', 'ilike', '%no_mrr%')
        .gte('updated_at', ninetyDaysAgo.toISOString()),

      // Agent usage: session count + total cost per agent_type (last 90 days)
      adminDb
        .from('sessions')
        .select('agent_type, total_cost_usd')
        .gte('started_at', ninetyDaysAgo.toISOString())
        .not('agent_type', 'is', null),

      // Funnel: profiles.onboarding_completed_at + sessions table
      adminDb
        .from('profiles')
        .select('id, onboarding_completed_at, created_at'),

      // Cohort data: profiles grouped by signup month (last 6 months)
      adminDb
        .from('profiles')
        .select('id, created_at')
        .gte('created_at', new Date(now.getUTCFullYear(), now.getUTCMonth() - 5, 1).toISOString())
        .order('created_at', { ascending: true }),
    ]);

    // -------------------------------------------------------------------------
    // MRR + Tier Mix
    // -------------------------------------------------------------------------

    const activeSubs = activeSubsResult.data ?? [];
    const tierCounts: Record<string, number> = {};
    let totalMrrUsd = 0;
    let totalTenureMonths = 0;

    for (const sub of activeSubs) {
      const tier = (sub.tier as string) || 'free';
      tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
      totalMrrUsd += mrrUsdForSubscription(
        tier,
        Boolean(sub.is_annual),
        (sub.seats as number | null | undefined) ?? null,
      );

      // Compute tenure in months for LTV estimate.
      const createdMs = new Date(sub.created_at as string).getTime();
      const tenureMs = Date.now() - createdMs;
      totalTenureMonths += tenureMs / (1000 * 60 * 60 * 24 * 30.44); // avg days/month
    }

    const tierMix: TierCount[] = Object.entries(tierCounts).map(([tier, count]) => ({
      tier,
      count,
    }));

    // -------------------------------------------------------------------------
    // Churn Rate
    // -------------------------------------------------------------------------

    const canceled = canceledSubsResult.data ?? [];
    const canceledLast30 = canceled.filter(
      (s) => new Date(s.updated_at as string) >= thirtyDaysAgo
    ).length;
    const canceledLast90 = canceled.length;

    // Active at start of period = current active + those that canceled during period.
    const activeAtStart30 = activeSubs.length + canceledLast30;
    const activeAtStart90 = activeSubs.length + canceledLast90;

    const churnRate30d = activeAtStart30 > 0 ? canceledLast30 / activeAtStart30 : null;
    const churnRate90d = activeAtStart90 > 0 ? canceledLast90 / activeAtStart90 : null;

    // -------------------------------------------------------------------------
    // LTV
    // -------------------------------------------------------------------------

    // WHY: LTV estimate = (avg subscription value) * (avg tenure months).
    // This is a simple cohort-naive estimate; a proper LTV model requires
    // historical retention curves which are in the cohortRetention section.
    // WHY canonical helper here too: the "is paid" filter and the avg-MRR
    // calc must agree with the totalMrrUsd loop above. Routing through
    // mrrUsdForSubscription guarantees they use the same Pro/Growth math
    // (sandbox-validated against Polar) and the same legacy fallback table.
    const paidSubs = activeSubs.filter((s) => {
      const tier = (s.tier as string) || 'free';
      return (
        mrrUsdForSubscription(
          tier,
          Boolean(s.is_annual),
          (s.seats as number | null | undefined) ?? null,
        ) > 0
      );
    });

    let avgLtvUsd: number | null = null;
    if (paidSubs.length > 0) {
      const avgMrrPerPaidSub =
        paidSubs.reduce(
          (sum, s) =>
            sum +
            mrrUsdForSubscription(
              (s.tier as string) ?? 'free',
              Boolean(s.is_annual),
              (s.seats as number | null | undefined) ?? null,
            ),
          0,
        ) / paidSubs.length;
      const avgTenureMonths = totalTenureMonths / activeSubs.length;
      avgLtvUsd = avgMrrPerPaidSub * Math.max(avgTenureMonths, 1);
    }

    // -------------------------------------------------------------------------
    // Agent Usage Distribution
    // -------------------------------------------------------------------------

    const agentSessions = agentUsageResult.data ?? [];
    const agentMap: Record<string, { count: number; cost: number }> = {};

    for (const session of agentSessions) {
      const agent = (session.agent_type as string) || 'unknown';
      if (!agentMap[agent]) agentMap[agent] = { count: 0, cost: 0 };
      agentMap[agent].count += 1;
      agentMap[agent].cost += Number(session.total_cost_usd) || 0;
    }

    const agentUsage: AgentUsage[] = Object.entries(agentMap)
      .map(([agentType, { count, cost }]) => ({
        agentType,
        sessionCount: count,
        totalCostUsd: cost,
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount);

    // -------------------------------------------------------------------------
    // Funnel
    // -------------------------------------------------------------------------

    const allProfiles = funnelResult.data ?? [];
    const totalUsers = allProfiles.length;
    const onboarded = allProfiles.filter((p) => p.onboarding_completed_at != null).length;

    // Users with at least one session (check via sessions table).
    // WHY: We already have the 90d session data; use a more targeted all-time query.
    const { count: firstSessionCount } = await adminDb
      .from('sessions')
      .select('user_id', { count: 'exact', head: true });

    // 7-day active (had at least one session in the last 7 days).
    const { data: sevenDayActiveData } = await adminDb
      .from('sessions')
      .select('user_id')
      .gte('started_at', sevenDaysAgo.toISOString());

    const active7d = new Set((sevenDayActiveData ?? []).map((r) => r.user_id as string)).size;

    // 30-day active.
    const { data: thirtyDayActiveData } = await adminDb
      .from('sessions')
      .select('user_id')
      .gte('started_at', thirtyDaysAgo.toISOString());

    const active30d = new Set((thirtyDayActiveData ?? []).map((r) => r.user_id as string)).size;

    const funnelRaw = [
      { step: 'Total users', count: totalUsers },
      { step: 'Onboarded', count: onboarded },
      { step: 'First session', count: firstSessionCount ?? 0 },
      { step: '7-day active', count: active7d },
      { step: '30-day active', count: active30d },
    ];

    const funnel: FunnelStep[] = funnelRaw.map((step, i) => ({
      step: step.step,
      count: step.count,
      conversionFromPrev:
        i === 0 || funnelRaw[i - 1].count === 0
          ? null
          : step.count / funnelRaw[i - 1].count,
    }));

    // -------------------------------------------------------------------------
    // Cohort Retention
    // -------------------------------------------------------------------------

    // Group profiles by YYYY-MM signup month.
    const cohortProfiles = cohortResult.data ?? [];
    const cohortMap: Record<string, string[]> = {};

    for (const p of cohortProfiles) {
      const month = (p.created_at as string).slice(0, 7); // YYYY-MM
      if (!cohortMap[month]) cohortMap[month] = [];
      cohortMap[month].push(p.id as string);
    }

    // For each cohort, compute fraction of users who had a session in the
    // 30d and 90d windows after their cohort month.
    const cohortRetention: CohortRetention[] = await Promise.all(
      Object.entries(cohortMap).map(async ([month, userIds]) => {
        const cohortStart = new Date(`${month}-01T00:00:00Z`);
        const cohortEnd30 = new Date(cohortStart);
        cohortEnd30.setDate(cohortEnd30.getDate() + 30);
        const cohortEnd90 = new Date(cohortStart);
        cohortEnd90.setDate(cohortEnd90.getDate() + 90);

        // Only compute retention for cohorts where the window has passed.
        const has30dPassed = cohortEnd30 <= now;
        const has90dPassed = cohortEnd90 <= now;

        let retention30d: number | null = null;
        let retention90d: number | null = null;

        if (has30dPassed && userIds.length > 0) {
          const { data: rows30 } = await adminDb
            .from('sessions')
            .select('user_id')
            .in('user_id', userIds)
            .gte('started_at', cohortStart.toISOString())
            .lt('started_at', cohortEnd30.toISOString());
          const active = new Set((rows30 ?? []).map((r) => r.user_id as string)).size;
          retention30d = active / userIds.length;
        }

        if (has90dPassed && userIds.length > 0) {
          const { data: rows90 } = await adminDb
            .from('sessions')
            .select('user_id')
            .in('user_id', userIds)
            .gte('started_at', cohortStart.toISOString())
            .lt('started_at', cohortEnd90.toISOString());
          const active = new Set((rows90 ?? []).map((r) => r.user_id as string)).size;
          retention90d = active / userIds.length;
        }

        return {
          cohortMonth: month,
          cohortSize: userIds.length,
          retention30d,
          retention90d,
        };
      })
    );

    // Sort cohorts newest first for the UI.
    cohortRetention.sort((a, b) => b.cohortMonth.localeCompare(a.cohortMonth));

    const metrics: FounderMetrics = {
      mrrUsd: totalMrrUsd,
      arrUsd: totalMrrUsd * 12,
      churnRate30d,
      churnRate90d,
      avgLtvUsd,
      tierMix,
      agentUsage,
      funnel,
      cohortRetention,
      computedAt: nowIso,
    };

    return NextResponse.json(metrics);
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[founder-metrics] Error:', isDev ? err : message);

    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: isDev ? message : 'Metrics computation failed' },
      { status: 500 }
    );
  }
}
