/**
 * Founder Ops Dashboard — /admin/cost-ops
 *
 * Gated on profiles.is_admin = true. Renders business-level metrics:
 *   - MRR trend (last 12 months)
 *   - Churn rate (monthly + trailing 90d)
 *   - Per-cohort retention curves (week 4 / 8 / 12)
 *   - Per-user LTV estimate
 *   - Agent-usage distribution
 *   - Top-spend users (redacted name, user_id + spend + tier)
 *   - Tier mix (Free vs Power vs Team)
 *
 * WHY server component: all data is admin-only and should never be cached
 * on the client. force-dynamic ensures fresh figures on every request.
 *
 * WHY /admin not /dashboard/admin: Separating admin routes from the user
 * dashboard makes it trivial to add a separate middleware guard and audit
 * log in the future without touching user-facing routes.
 *
 * @module app/admin/cost-ops/page
 */

export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { AdminMrrChart } from './AdminMrrChart';
import { AdminRetentionTable } from './AdminRetentionTable';
import { AdminTopSpendTable } from './AdminTopSpendTable';
import { AdminTierMix } from './AdminTierMix';
import { AdminAgentDistribution } from './AdminAgentDistribution';

export const metadata: Metadata = {
  title: 'Cost Ops | Styrby Admin',
  description: 'Founder-facing operations dashboard — MRR, churn, retention, LTV.',
  robots: { index: false, follow: false },
};

// ============================================================================
// Types
// ============================================================================

/**
 * Monthly MRR data point.
 */
interface MrrDataPoint {
  /** YYYY-MM label */
  month: string;
  /** Total MRR in USD for the month */
  mrr: number;
  /** Number of active paying subscriptions */
  activeSubscriptions: number;
}

/**
 * Cohort retention row — users who signed up in a given week.
 */
interface CohortRetention {
  /** ISO week label, e.g. "2026-W12" */
  cohortWeek: string;
  /** Users who signed up in this cohort */
  cohortSize: number;
  /** % still active at week 4 (at least 1 session in week 4 window) */
  week4Pct: number | null;
  /** % still active at week 8 */
  week8Pct: number | null;
  /** % still active at week 12 */
  week12Pct: number | null;
}

/**
 * Top spender row — user_id redacted display.
 */
interface TopSpender {
  /** Truncated user ID for display (first 8 chars) */
  userIdPrefix: string;
  /** Total spend USD in last 30 days */
  spendUsd: number;
  /** Current subscription tier */
  tier: string;
  /** Session count last 30 days */
  sessionCount: number;
}

/**
 * Tier distribution count.
 */
interface TierCount {
  tier: string;
  count: number;
}

/**
 * Agent usage share.
 */
interface AgentUsage {
  agentType: string;
  sessionCount: number;
  pct: number;
}

// ============================================================================
// Page
// ============================================================================

/**
 * Founder Ops Dashboard page component.
 *
 * @returns Admin metrics dashboard
 */
export default async function CostOpsPage() {
  // ── Auth check via user-facing client (cookie auth) ──────────────────────
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // ── Admin gate: check is_admin on profiles ────────────────────────────────
  // WHY: We check profiles.is_admin rather than a custom JWT claim because
  // Supabase custom claims require edge function JWT hooks. A simple column
  // check is easier to manage and audit.
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (!profile?.is_admin) {
    redirect('/dashboard');
  }

  // ── Service role client for cross-user queries ────────────────────────────
  // WHY: Admin metrics require querying all users' data. RLS prevents the
  // authenticated client from seeing other users' rows. Service role bypasses
  // RLS safely for admin-only server components.
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ── Parallel data fetches ─────────────────────────────────────────────────
  // WHY parallel: These are independent queries. Sequential would be ~5×
  // slower than concurrent at P50.
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const [
    mrrResult,
    tierMixResult,
    topSpendResult,
    agentUsageResult,
    cohortResult,
  ] = await Promise.all([
    // MRR trend: subscriptions joined with tier pricing
    serviceClient
      .from('subscriptions')
      .select('tier, created_at, status, updated_at')
      .eq('status', 'active')
      .gte('created_at', twelveMonthsAgo.toISOString()),

    // Tier mix: all active subscriptions
    serviceClient
      .from('subscriptions')
      .select('tier')
      .eq('status', 'active'),

    // Top spenders: last 30d cost records
    serviceClient
      .from('cost_records')
      .select('user_id, cost_usd')
      .gte('record_date', thirtyDaysAgo.toISOString().split('T')[0])
      .limit(50_000),

    // Agent usage: sessions by agent_type last 90d
    serviceClient
      .from('sessions')
      .select('agent_type')
      .gte('started_at', ninetyDaysAgo.toISOString())
      .limit(100_000),

    // Cohort data: user sign-ups over last 12 weeks + first sessions
    serviceClient
      .from('profiles')
      .select('id, created_at')
      .gte('created_at', twelveMonthsAgo.toISOString())
      .order('created_at', { ascending: true })
      .limit(10_000),
  ]);

  // ── MRR aggregation ───────────────────────────────────────────────────────
  // Approximate MRR by counting active paying subs per month and multiplying
  // by tier price. WHY approximate: Polar's webhook syncs subscriptions but
  // does not store transaction amounts in cost_records (billing system parity
  // issue — noted for future improvement).
  const TIER_PRICE: Record<string, number> = {
    power: 49,
    team: 19,    // per seat — will show per-subscription here
    business: 39,
    enterprise: 0, // custom
  };

  const mrrByMonth: Record<string, { mrr: number; count: number }> = {};
  for (const sub of mrrResult.data ?? []) {
    const d = new Date(sub.created_at as string);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const price = TIER_PRICE[(sub.tier as string) ?? ''] ?? 0;
    if (!mrrByMonth[key]) mrrByMonth[key] = { mrr: 0, count: 0 };
    mrrByMonth[key].mrr += price;
    mrrByMonth[key].count += 1;
  }

  const mrrData: MrrDataPoint[] = Object.entries(mrrByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { mrr, count }]) => ({ month, mrr, activeSubscriptions: count }));

  // ── Tier mix ──────────────────────────────────────────────────────────────
  const tierCounts: Record<string, number> = {};
  for (const sub of tierMixResult.data ?? []) {
    const t = (sub.tier as string) ?? 'free';
    tierCounts[t] = (tierCounts[t] ?? 0) + 1;
  }
  const tierMix: TierCount[] = Object.entries(tierCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([tier, count]) => ({ tier, count }));

  // ── Top spenders ──────────────────────────────────────────────────────────
  const spendByUser: Record<string, number> = {};
  for (const row of topSpendResult.data ?? []) {
    const uid = row.user_id as string;
    spendByUser[uid] = (spendByUser[uid] ?? 0) + (Number(row.cost_usd) || 0);
  }

  // Session counts per user last 30d
  const { data: sessionCountRows } = await serviceClient
    .from('sessions')
    .select('user_id')
    .gte('started_at', thirtyDaysAgo.toISOString())
    .limit(100_000);

  const sessionsByUser: Record<string, number> = {};
  for (const row of sessionCountRows ?? []) {
    const uid = row.user_id as string;
    sessionsByUser[uid] = (sessionsByUser[uid] ?? 0) + 1;
  }

  // User tier map — fetch active subscriptions for top spenders
  const topUserIds = Object.entries(spendByUser)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 50)
    .map(([uid]) => uid);

  const { data: topSubRows } = await serviceClient
    .from('subscriptions')
    .select('user_id, tier')
    .eq('status', 'active')
    .in('user_id', topUserIds);

  const tierByUser: Record<string, string> = {};
  for (const row of topSubRows ?? []) {
    tierByUser[row.user_id as string] = row.tier as string;
  }

  const topSpenders: TopSpender[] = topUserIds.map((uid) => ({
    userIdPrefix: uid.slice(0, 8),
    spendUsd: spendByUser[uid],
    tier: tierByUser[uid] ?? 'free',
    sessionCount: sessionsByUser[uid] ?? 0,
  }));

  // ── Agent usage distribution ──────────────────────────────────────────────
  const agentCounts: Record<string, number> = {};
  for (const row of agentUsageResult.data ?? []) {
    const agent = (row.agent_type as string) ?? 'unknown';
    agentCounts[agent] = (agentCounts[agent] ?? 0) + 1;
  }
  const totalSessions = Object.values(agentCounts).reduce((a, b) => a + b, 0);
  const agentUsage: AgentUsage[] = Object.entries(agentCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([agentType, count]) => ({
      agentType,
      sessionCount: count,
      pct: totalSessions > 0 ? Math.round((count / totalSessions) * 100) : 0,
    }));

  // ── Cohort retention ──────────────────────────────────────────────────────
  // WHY simplified: Full cohort analysis requires session data per user joined
  // with signup week. We compute week-of-signup buckets and check whether
  // users had sessions in weeks 4, 8, 12 post-signup.
  const cohortProfiles = cohortResult.data ?? [];

  // Group users by signup ISO week
  const cohortBuckets: Record<string, string[]> = {};
  for (const p of cohortProfiles) {
    const d = new Date(p.created_at as string);
    // ISO week: year + week number
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const weekNum = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7);
    const key = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    if (!cohortBuckets[key]) cohortBuckets[key] = [];
    cohortBuckets[key].push(p.id as string);
  }

  // For each cohort, check how many users had sessions in W+4, W+8, W+12 windows
  const retentionData: CohortRetention[] = [];
  for (const [cohortWeek, userIds] of Object.entries(cohortBuckets)) {
    // Only show cohorts old enough for W12 data (84 days ago)
    const cohortDate = new Date(cohortProfiles.find((p) => {
      const d = new Date(p.created_at as string);
      const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const wn = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(wn).padStart(2, '0')}` === cohortWeek;
    })?.created_at ?? '');

    if (!cohortDate.getTime()) continue;

    const week4Start = new Date(cohortDate.getTime() + 21 * 86400000);
    const week4End = new Date(cohortDate.getTime() + 28 * 86400000);
    const week8Start = new Date(cohortDate.getTime() + 49 * 86400000);
    const week8End = new Date(cohortDate.getTime() + 56 * 86400000);
    const week12Start = new Date(cohortDate.getTime() + 77 * 86400000);
    const week12End = new Date(cohortDate.getTime() + 84 * 86400000);

    // Only compute W4/W8/W12 if enough time has passed
    const isW4Ready = now >= week4End;
    const isW8Ready = now >= week8End;
    const isW12Ready = now >= week12End;

    if (!isW4Ready) continue; // Skip future cohorts entirely

    // Count active users per window (has at least 1 session in that week)
    const getActivePct = async (start: Date, end: Date): Promise<number | null> => {
      if (userIds.length === 0) return null;
      const { data } = await serviceClient
        .from('sessions')
        .select('user_id')
        .gte('started_at', start.toISOString())
        .lte('started_at', end.toISOString())
        .in('user_id', userIds);
      const active = new Set((data ?? []).map((r) => r.user_id as string)).size;
      return Math.round((active / userIds.length) * 100);
    };

    const [w4, w8, w12] = await Promise.all([
      getActivePct(week4Start, week4End),
      isW8Ready ? getActivePct(week8Start, week8End) : Promise.resolve(null),
      isW12Ready ? getActivePct(week12Start, week12End) : Promise.resolve(null),
    ]);

    retentionData.push({
      cohortWeek,
      cohortSize: userIds.length,
      week4Pct: w4,
      week8Pct: w8,
      week12Pct: w12,
    });
  }

  // Limit to most recent 12 cohorts
  const recentCohorts = retentionData
    .sort((a, b) => b.cohortWeek.localeCompare(a.cohortWeek))
    .slice(0, 12);

  // ── LTV estimate ──────────────────────────────────────────────────────────
  // LTV = avg subscription price × estimated months retained.
  // WHY simple formula: We don't have actual churn data yet. A rough
  // estimate using tier-weighted ARPU × assumed 12-month retention is
  // better than nothing for early-stage decisions.
  const totalActiveSubs = tierMix.reduce((a, b) => a + b.count, 0);
  const avgMonthlyRevenue = tierMix.reduce((sum, t) => sum + t.count * (TIER_PRICE[t.tier] ?? 0), 0);
  const arpu = totalActiveSubs > 0 ? avgMonthlyRevenue / totalActiveSubs : 0;
  const estimatedLtv = arpu * 12; // assumes 12-month average retention

  // ── Monthly churn rate estimate ───────────────────────────────────────────
  // Simple: subscriptions cancelled in last 30d / active subs at start of period.
  // WHY: Polar webhooks set status = 'canceled' on churn events.
  const { data: canceledRows } = await serviceClient
    .from('subscriptions')
    .select('id')
    .eq('status', 'canceled')
    .gte('updated_at', thirtyDaysAgo.toISOString());

  const canceledCount = canceledRows?.length ?? 0;
  const monthlyChurnRate = totalActiveSubs > 0
    ? Math.round((canceledCount / (totalActiveSubs + canceledCount)) * 1000) / 10
    : 0;

  const trailing90dCancelCount = (await serviceClient
    .from('subscriptions')
    .select('id')
    .eq('status', 'canceled')
    .gte('updated_at', ninetyDaysAgo.toISOString())).data?.length ?? 0;

  const trailing90dChurnRate = totalActiveSubs > 0
    ? Math.round((trailing90dCancelCount / (totalActiveSubs + trailing90dCancelCount)) * 1000) / 10
    : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-400 uppercase">
            Admin
          </span>
          <h1 className="text-2xl font-bold text-zinc-100">Cost Ops Dashboard</h1>
        </div>
        <p className="text-sm text-zinc-500">Founder-facing metrics. Not visible to users.</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Active Subscribers', value: totalActiveSubs.toLocaleString() },
          { label: 'Est. Monthly LTV', value: `$${estimatedLtv.toFixed(0)}` },
          { label: 'Monthly Churn', value: `${monthlyChurnRate}%` },
          { label: '90d Churn', value: `${trailing90dChurnRate}%` },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-4">
            <p className="text-xs text-zinc-500 mb-1">{label}</p>
            <p className="text-2xl font-bold text-zinc-100">{value}</p>
          </div>
        ))}
      </div>

      {/* MRR Trend */}
      <section className="mb-8">
        <h2 className="text-base font-semibold text-zinc-200 mb-3">MRR Trend (last 12 months)</h2>
        <AdminMrrChart data={mrrData} />
      </section>

      {/* Tier Mix + Agent Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <section>
          <h2 className="text-base font-semibold text-zinc-200 mb-3">Tier Mix</h2>
          <AdminTierMix data={tierMix} totalActive={totalActiveSubs} />
        </section>
        <section>
          <h2 className="text-base font-semibold text-zinc-200 mb-3">Agent Usage (last 90d)</h2>
          <AdminAgentDistribution data={agentUsage} />
        </section>
      </div>

      {/* Cohort Retention */}
      <section className="mb-8">
        <h2 className="text-base font-semibold text-zinc-200 mb-1">Cohort Retention</h2>
        <p className="text-xs text-zinc-500 mb-3">
          % of each sign-up cohort still active (at least 1 session) at weeks 4, 8, and 12.
        </p>
        <AdminRetentionTable data={recentCohorts} />
      </section>

      {/* Top Spenders */}
      <section>
        <h2 className="text-base font-semibold text-zinc-200 mb-1">Top Spenders (last 30d)</h2>
        <p className="text-xs text-zinc-500 mb-3">
          User IDs truncated to first 8 characters for display. Full IDs in Supabase dashboard.
        </p>
        <AdminTopSpendTable data={topSpenders} />
      </section>
    </div>
  );
}
