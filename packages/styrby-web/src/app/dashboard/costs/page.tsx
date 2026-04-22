// WHY: force-dynamic ensures this page is always server-rendered at request time.
// Cost analytics are user-specific and update continuously during active sessions -
// a cached response would show incorrect spend totals and stale budget alert state.
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
// WHY dynamic import: Recharts (~250 kB gzipped) is deferred so it only loads
// for Power-tier users who actually see the charts. All other tiers hit the
// upgrade card instead, so they never pay the Recharts bundle cost.
import { CostChartsDynamic as CostCharts } from './cost-charts-dynamic';
import { CostsRealtime } from './costs-realtime';
import { BudgetAlertsSummary } from './budget-alerts-summary';
import { TokenUsageSummary } from './token-usage-summary';
import { TimeRangeSelect } from './time-range-select';
import { TeamCosts } from './team-costs';
import { TIERS, type TierId } from '@/lib/polar';
import { MODEL_PRICING, LAST_VERIFIED } from '@/lib/model-pricing';
import { ExportButton } from './export-button';
import { BillingModelSummaryStrip } from './billing-model-summary-strip';
import { RunRateProjection } from '@/components/costs/RunRateProjection';
import { TierCapWarning } from '@/components/costs/TierCapWarning';
import { SessionCostTable } from '@/components/costs/SessionCostTable';
import type { AgentType } from '@/lib/costs';

export const metadata: Metadata = {
  title: 'Cost Analytics | Styrby',
  description: 'Track AI agent spending by day, model, and tag. Set budget alerts and export cost reports.',
};

/**
 * Calculates the start of the current period for spend aggregation.
 *
 * WHY: Hoisted to module level so this pure function is not re-declared on every
 * server render. It has no component-level dependencies, so it belongs here.
 *
 * @param period - Budget period type
 * @returns ISO date string for the period start
 */
function getPeriodStartDate(period: string): string {
  const now = new Date();
  switch (period) {
    case 'daily': {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    }
    case 'weekly': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = start.getUTCDay();
      start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
      return start.toISOString();
    }
    case 'monthly': {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    }
    default:
      return new Date().toISOString();
  }
}

/**
 * NOTE: Navigation chrome (sidebar, topnav) is handled by dashboard/layout.tsx.
 */

/**
 * Cost Analytics page - displays spending data, charts, and budget alert summary.
 *
 * WHY budget alerts appear here: Users checking their costs are the most likely
 * audience for budget alerts. Surfacing the most critical alert on this page
 * drives discovery and engagement with the alerts feature.
 *
 * WHY CostsRealtime wrapper: The summary cards show real-time spending updates
 * as new cost records are created. This allows users to see their spending
 * increase live during active sessions without requiring page refresh.
 */
export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Parse time range from URL searchParams (default: 30 days).
  // WHY: Using searchParams makes the time range bookmarkable and allows the
  // server component to adjust its query without client-side state management.
  const params = await searchParams;
  const daysRaw = Number(params.days);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;

  // Fetch daily cost summary - includes agent_type and model dimensions.
  // WHY: After migration 010, mv_daily_cost_summary groups by (user_id, record_date,
  // agent_type, model). A single MV query now provides all data needed for the daily
  // trend chart, per-agent breakdown, and per-model breakdown - eliminating the
  // separate raw cost_records table scan that previously fetched up to 10,000 rows.
  //
  // WHY v_my_daily_costs (migration 016): Migration 016 revokes authenticated SELECT
  // on the raw mv_daily_cost_summary materialized view and instead exposes
  // v_my_daily_costs — a security-definer view that applies
  // WHERE user_id = (SELECT auth.uid()) before returning rows. This closes a
  // data-leak where a misconfigured RLS policy could expose other users' cost data.
  // The view has identical columns; no .eq('user_id', ...) filter is needed because
  // the view already enforces per-user isolation at the database layer.
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - days);
  const rangeStartDate = rangeStart.toISOString().split('T')[0];

  // Fetch billing model breakdown for the selected period.
  // WHY separate query: v_my_daily_costs is a pre-aggregated materialized view
  // that does not include billing_model or source — those are raw cost_records
  // columns added in migration 022. Rather than break the MV contract, we query
  // cost_records directly and aggregate the four billing buckets in JS.
  // .limit(5000) guards serverless memory for users with many sessions.
  const billingBreakdownPromise = supabase
    .from('cost_records')
    .select('billing_model, source, cost_usd, subscription_fraction_used, credits_consumed, credit_rate_usd')
    .gte('record_date', rangeStartDate)
    .limit(5000);

  const { data: mvRows } = await supabase
    .from('v_my_daily_costs')
    .select('record_date, agent_type, model, total_cost_usd, total_input_tokens, total_output_tokens, record_count')
    .gte('record_date', rangeStartDate)
    .order('record_date', { ascending: true });

  // Derive agent totals, model totals, and chart data from a single pass over the MV rows.
  // WHY single pass: the MV is already grouped, so we aggregate the pre-summed column
  // values rather than re-scanning individual cost_records rows. This is O(MV rows)
  // instead of O(raw rows), and the MV is orders of magnitude smaller.
  type AgentTotal = { cost: number; inputTokens: number; outputTokens: number };
  type ModelTotal = { cost: number; requests: number };
  type DayBucket = { total: number; claude: number; codex: number; gemini: number };

  const agentTotals: Record<string, AgentTotal> = {};
  const modelTotals: Record<string, ModelTotal> = {};
  const dayBuckets: Record<string, DayBucket> = {};

  for (const row of mvRows ?? []) {
    const cost = Number(row.total_cost_usd) || 0;
    const inputTokens = Number(row.total_input_tokens) || 0;
    const outputTokens = Number(row.total_output_tokens) || 0;
    const recordCount = Number(row.record_count) || 0;
    const agent = row.agent_type || 'unknown';
    const model = row.model || 'unknown';
    const date = row.record_date as string;

    // --- Agent totals ---
    if (!agentTotals[agent]) {
      agentTotals[agent] = { cost: 0, inputTokens: 0, outputTokens: 0 };
    }
    agentTotals[agent].cost += cost;
    agentTotals[agent].inputTokens += inputTokens;
    agentTotals[agent].outputTokens += outputTokens;

    // --- Model totals ---
    // WHY record_count: the MV pre-counts rows per (date, agent, model) group,
    // so we sum record_count instead of incrementing by 1 per raw record.
    if (!modelTotals[model]) {
      modelTotals[model] = { cost: 0, requests: 0 };
    }
    modelTotals[model].cost += cost;
    modelTotals[model].requests += recordCount;

    // --- Daily chart buckets ---
    if (!dayBuckets[date]) {
      dayBuckets[date] = { total: 0, claude: 0, codex: 0, gemini: 0 };
    }
    dayBuckets[date].total += cost;
    if (agent === 'claude') dayBuckets[date].claude += cost;
    else if (agent === 'codex') dayBuckets[date].codex += cost;
    else if (agent === 'gemini') dayBuckets[date].gemini += cost;
  }

  // Build chart data array sorted ascending by date (MV is ordered DESC, buckets need ASC).
  const chartData = Object.entries(dayBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      date,
      total: bucket.total,
      claude: bucket.claude,
      codex: bucket.codex,
      gemini: bucket.gemini,
    }));

  // Fetch budget alerts summary data for the widget
  // WHY: We fetch alerts here instead of in a separate component because
  // this is a server component and we already have the authenticated Supabase client.
  // Fetch sessions with tags for cost-by-tag aggregation.
  // WHY: The Supabase JS client does not support SQL `unnest()`, so we fetch sessions
  // that have at least one tag and aggregate by tag in JavaScript. We limit to 200
  // sessions (last 30 days) which is more than enough for typical usage patterns.
  // This is efficient because sessions already store total_cost_usd as a pre-aggregated
  // column, so we never touch the cost_records table for this query.
  const { data: taggedSessions } = await supabase
    .from('sessions')
    .select('tags, total_cost_usd')
    .gte('started_at', rangeStart.toISOString())
    .not('tags', 'eq', '{}')
    .order('started_at', { ascending: false })
    .limit(200);

  // Aggregate costs by tag (a session with multiple tags contributes to each tag).
  type TagTotal = { cost: number; sessionCount: number };
  const tagTotals: Record<string, TagTotal> = {};

  for (const session of taggedSessions ?? []) {
    const cost = Number(session.total_cost_usd) || 0;
    const tags = session.tags as string[] | null;
    if (!tags || tags.length === 0) continue;
    for (const tag of tags) {
      if (!tagTotals[tag]) {
        tagTotals[tag] = { cost: 0, sessionCount: 0 };
      }
      tagTotals[tag].cost += cost;
      tagTotals[tag].sessionCount += 1;
    }
  }

  // Resolve billing breakdown query and aggregate into four buckets.
  const { data: billingRows } = await billingBreakdownPromise;

  // WHY separate bucket for each billing model: The header summary strip shows
  // "API: $X | Subscription: Y% | Credits: Z cr ($W)" so we need per-model totals.
  type BillingBuckets = {
    apiKeyCostUsd: number;
    subscriptionFractionSum: number;
    subscriptionRowCount: number;
    creditsConsumed: number;
    creditCostUsd: number;
    freeCostUsd: number;
  };
  const billingBuckets: BillingBuckets = {
    apiKeyCostUsd: 0,
    subscriptionFractionSum: 0,
    subscriptionRowCount: 0,
    creditsConsumed: 0,
    creditCostUsd: 0,
    freeCostUsd: 0,
  };

  for (const row of billingRows ?? []) {
    const cost = Number(row.cost_usd) || 0;
    switch (row.billing_model) {
      case 'api-key':
        billingBuckets.apiKeyCostUsd += cost;
        break;
      case 'subscription':
        billingBuckets.subscriptionRowCount += 1;
        if (row.subscription_fraction_used != null) {
          billingBuckets.subscriptionFractionSum += Number(row.subscription_fraction_used) || 0;
        }
        break;
      case 'credit':
        billingBuckets.creditsConsumed += Number(row.credits_consumed) || 0;
        billingBuckets.creditCostUsd += cost;
        break;
      case 'free':
        billingBuckets.freeCostUsd += cost;
        break;
      // WHY no default: unknown billing_model values are silently ignored so
      // dashboard rendering is never blocked by unexpected DB values.
    }
  }

  // Derive average subscription fraction used for display.
  const avgSubscriptionFraction =
    billingBuckets.subscriptionRowCount > 0
      ? billingBuckets.subscriptionFractionSum / billingBuckets.subscriptionRowCount
      : null;

  // Fetch budget alerts, subscription tier, and (if Power) team membership in parallel.
  // WHY parallel: These are independent queries. Running them concurrently cuts
  // the p99 latency from ~3× serial query time to ~1× the slowest query.
  const [alertsResult, subscriptionResult, teamMemberResult] = await Promise.all([
    supabase
      .from('budget_alerts')
      .select('id, name, threshold_usd, period, agent_type, action, is_enabled')
      .eq('user_id', user.id)
      .eq('is_enabled', true)
      .order('created_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single(),
    // WHY: Pre-fetch team membership so we can render TeamCosts without an
    // extra round-trip. We only use the result for Power tier users.
    supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
  ]);

  const budgetAlerts = alertsResult.data || [];
  const userTier = (subscriptionResult.data?.tier as TierId) || 'free';
  const alertLimit = TIERS[userTier]?.limits.budgetAlerts ?? 0;

  // Only expose team data on Power tier - other tiers don't have team access.
  const teamId = userTier === 'power'
    ? (teamMemberResult.data?.team_id as string | null) ?? null
    : null;

  // WHY: We compute the "most critical" alert (highest % used) to show in the
  // summary widget. This gives users an at-a-glance view of their closest alert.
  // getPeriodStartDate is defined at module level (above) for performance.
  let mostCriticalAlert: {
    name: string;
    threshold_usd: number;
    current_spend_usd: number;
    percentage_used: number;
    period: string;
    action: string;
    agent_type: string | null;
  } | null = null;

  if (budgetAlerts.length > 0) {
    // WHY: Deduplicate spend queries by (period, agent_type) pair to avoid an
    // N+1 pattern where each alert triggers its own DB query. With 10 alerts on
    // 3 periods + 3 agents, we reduce up to 10 queries down to at most 12
    // (4 periods × 3 agent slots), but typically far fewer in practice.
    // The composite key encodes both dimensions so null agent_type (all-agents)
    // is correctly distinguished from agent-scoped alerts.
    const uniqueKeys = [...new Set(
      budgetAlerts.map((a) => `${a.period}:${a.agent_type ?? 'null'}`)
    )];

    const spendByKey: Record<string, number> = {};

    await Promise.all(
      uniqueKeys.map(async (key) => {
        const [period, agentTypeRaw] = key.split(':') as [string, string];
        const agentType = agentTypeRaw === 'null' ? null : agentTypeRaw;
        const periodStart = getPeriodStartDate(period);

        let query = supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', user.id)
          .gte('recorded_at', periodStart);

        if (agentType) {
          query = query.eq('agent_type', agentType);
        }

        const { data: costData } = await query;
        spendByKey[key] = (costData || []).reduce(
          (sum, r) => sum + (Number(r.cost_usd) || 0),
          0
        );
      })
    );

    const alertsWithSpend = budgetAlerts.map((alert) => {
      const key = `${alert.period}:${alert.agent_type ?? 'null'}`;
      const currentSpend = spendByKey[key] ?? 0;
      const threshold = Number(alert.threshold_usd);

      return {
        name: alert.name,
        threshold_usd: threshold,
        current_spend_usd: currentSpend,
        percentage_used: threshold > 0 ? (currentSpend / threshold) * 100 : 0,
        period: alert.period,
        action: alert.action,
        agent_type: alert.agent_type,
      };
    });

    // Sort by percentage used descending, pick the most critical
    alertsWithSpend.sort((a, b) => b.percentage_used - a.percentage_used);
    mostCriticalAlert = alertsWithSpend[0];
  }

  // ── Run-rate projection data ────────────────────────────────────────────────
  // Compute last-7d spend and distinct-day count for the RunRateProjection banner.
  // WHY separate query: the MV only covers the selected `days` window which may
  // be 30 or 90 days. For the run-rate we always need exactly the last 7 days.
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoDate = sevenDaysAgo.toISOString().split('T')[0];

  const { data: runRateRows } = await supabase
    .from('v_my_daily_costs')
    .select('record_date, total_cost_usd')
    .gte('record_date', sevenDaysAgoDate);

  let last7dSpendUsd = 0;
  const distinctDays = new Set<string>();
  for (const row of runRateRows ?? []) {
    last7dSpendUsd += Number(row.total_cost_usd) || 0;
    if (row.record_date) distinctDays.add(row.record_date as string);
  }
  const historyDays = distinctDays.size;

  // Month-to-date spend from the full MV result (rangeStart is already month start when days=30).
  // WHY: We compute MTD from the existing chartData to avoid an extra DB query.
  const now = new Date();
  const monthStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().split('T')[0];
  const monthToDateSpendUsd = (runRateRows ?? [])
    .filter((r) => (r.record_date as string) >= monthStartDate)
    .reduce((sum, r) => sum + (Number(r.total_cost_usd) || 0), 0);

  // Determine monthly cap from lowest-threshold enabled monthly budget alert.
  const monthlyCapAlert = budgetAlerts
    .filter((a) => a.period === 'monthly' && !a.agent_type)
    .sort((a, b) => Number(a.threshold_usd) - Number(b.threshold_usd))[0];
  const monthlyCap = monthlyCapAlert ? Number(monthlyCapAlert.threshold_usd) : null;

  // Fetch top sessions by cost for the SessionCostTable drill-in.
  // WHY: Users want to see which specific sessions drove their costs.
  // Limiting to 10 keeps the table scannable and the query fast.
  const { data: topSessions } = await supabase
    .from('sessions')
    .select('id, title, summary, agent_type, total_cost_usd, message_count, started_at')
    .gte('started_at', rangeStart.toISOString())
    .gt('total_cost_usd', 0)
    .order('total_cost_usd', { ascending: false })
    .limit(10);

  // Dominant billing model for run-rate copy variant.
  const dominantBillingModel = ((): 'api-key' | 'subscription' | 'credit' | 'free' => {
    const counts = {
      'api-key': billingBuckets.apiKeyCostUsd > 0 ? 1 : 0,
      subscription: billingBuckets.subscriptionRowCount,
      credit: billingBuckets.creditsConsumed > 0 ? 1 : 0,
      free: 0,
    };
    return (Object.entries(counts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'api-key') as 'api-key' | 'subscription' | 'credit' | 'free';
  })();

  return (
    <div>
      <div className="flex flex-col gap-4 mb-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-foreground">Cost Analytics</h1>
          <Link
            href="/dashboard/costs/budget-alerts"
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors flex items-center gap-1.5"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            Budget Alerts
          </Link>

          {/* Export button - Power tier only, locked/greyed for Free and Pro */}
          {/* WHY: Export is a Power differentiator. Showing the locked state to
              Free/Pro users reinforces the upsell path without hiding the feature. */}
          <ExportButton isPowerTier={userTier === 'power'} days={days} />
        </div>

        {/* Time range selector - client component for onChange interactivity */}
        <TimeRangeSelect currentDays={days} />
      </div>

      {/* Billing model summary strip — shows variable / subscription / credit totals */}
      {/* WHY here: Users glancing at the cost page need an immediate answer to
          "how much of my spend is API vs subscription vs credits?" before they
          scroll into charts. One line at the top delivers that. */}
      <BillingModelSummaryStrip
        apiKeyCostUsd={billingBuckets.apiKeyCostUsd}
        subscriptionFractionUsed={avgSubscriptionFraction}
        subscriptionRowCount={billingBuckets.subscriptionRowCount}
        creditsConsumed={billingBuckets.creditsConsumed}
        creditCostUsd={billingBuckets.creditCostUsd}
        days={days}
      />

      {/* Run-rate projection banner — shows when ≥3 days of history and cap configured.
          WHY at top: forward-looking spend awareness should be the first thing
          a user sees on the cost page, not buried below charts. */}
      <RunRateProjection
        last7dSpendUsd={historyDays >= 3 ? last7dSpendUsd : null}
        historyDays={historyDays}
        monthToDateSpendUsd={monthToDateSpendUsd}
        monthlyCap={monthlyCap}
        billingModel={dominantBillingModel}
        avgDailySubscriptionFraction={
          dominantBillingModel === 'subscription' && billingBuckets.subscriptionRowCount > 0
            ? (billingBuckets.subscriptionFractionSum / billingBuckets.subscriptionRowCount) / 7
            : null
        }
        subscriptionQuota={1.0}
      />

      {/* Tier cap warning — client component (snooze via localStorage).
          WHY here: immediately visible before charts, gives the user context
          about why they might be seeing elevated spend. */}
      <TierCapWarning tier={userTier} monthToDateSpendUsd={monthToDateSpendUsd} />

      {/* Real-time summary cards with connection status */}
      <CostsRealtime
        initialAgentTotals={agentTotals}
        userId={user.id}
      >
        {/* Budget Alerts Summary Widget */}
        <BudgetAlertsSummary
          mostCriticalAlert={mostCriticalAlert}
          alertCount={budgetAlerts.length}
          tier={userTier}
          alertLimit={alertLimit}
        />

        {/* Daily Cost Charts - Power tier only.
            WHY: The full daily spending chart (area chart + stacked bars + pie)
            is a Power differentiator. Free/Pro users see a locked upgrade card
            that teases the feature. They still see token totals and model/tag
            breakdowns below - those are available to all tiers. */}
        {userTier === 'power' ? (
          <CostCharts data={chartData} />
        ) : (
          <div className="mt-4 rounded-xl border border-border/60 bg-card/40 p-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-muted-foreground shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
              <div>
                <p className="text-sm font-medium text-foreground">Daily Cost Charts</p>
                <p className="text-xs text-muted-foreground">
                  Full spending trends, per-agent breakdown, and daily charts. Available on Power.
                </p>
              </div>
            </div>
            <Link
              href="/pricing"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/20 transition-colors"
            >
              Upgrade to Power
            </Link>
          </div>
        )}
      </CostsRealtime>

      {/* Token Usage Summary */}
      {/* WHY: Explicit token usage gives developers visibility into how much
          context they're consuming, which directly affects costs and helps
          them optimize prompts. This mirrors the mobile app's "TOKEN USAGE (MONTH)"
          section with input, output, and total token counts. */}
      <TokenUsageSummary agentTotals={agentTotals} />

      {/* Model breakdown */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Cost by Model
        </h2>
        <div className="rounded-xl bg-card/60 border border-border/40 divide-y divide-border/20">
          {Object.entries(modelTotals)
            .sort(([, a], [, b]) => b.cost - a.cost)
            .map(([model, data]) => (
              <div
                key={model}
                className="px-4 py-3 flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{model}</p>
                  <p className="text-xs text-muted-foreground">
                    {data.requests.toLocaleString()} requests
                  </p>
                </div>
                <p className="text-sm font-semibold text-foreground">
                  ${data.cost.toFixed(4)}
                </p>
              </div>
            ))}
          {Object.keys(modelTotals).length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-muted-foreground">No usage data yet</p>
            </div>
          )}
        </div>
      </section>

      {/* Tag cost breakdown */}
      {/* WHY: Freelance developers and agencies need to attribute AI spending to
          specific clients or projects. Tags on sessions enable this without requiring
          a full project management system. Users tag sessions with client names
          (e.g., "acme-corp") and this section shows the cost breakdown per tag. */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-foreground mb-1">
          Cost by Tag
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Tag sessions from the CLI or session detail page to track costs per client or project.
        </p>
        <div className="rounded-xl bg-card/60 border border-border/40 divide-y divide-border/20">
          {Object.entries(tagTotals)
            .sort(([, a], [, b]) => b.cost - a.cost)
            .map(([tag, data]) => (
              <div
                key={tag}
                className="px-4 py-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-500">
                    {tag}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {data.sessionCount} {data.sessionCount === 1 ? 'session' : 'sessions'}
                  </p>
                </div>
                <p className="text-sm font-semibold text-foreground">
                  ${data.cost.toFixed(2)}
                </p>
              </div>
            ))}
          {Object.keys(tagTotals).length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-muted-foreground text-sm">No tagged sessions yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Add tags to sessions to see cost breakdowns by client or project.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Top Sessions by Cost — drill-in table with per-session cost breakdown.
          WHY: Users want to see WHICH sessions drove their costs, not just
          which agents. The drill-in modal gives them per-message detail
          without navigating away from the cost dashboard. */}
      {(topSessions ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Top Sessions by Cost
          </h2>
          <SessionCostTable
            sessions={(topSessions ?? []).map((s) => ({
              id: s.id as string,
              label: (s.title as string | null) ?? (s.summary as string | null) ?? `Session ${(s.id as string).slice(0, 8)}`,
              agentType: (s.agent_type as string) as AgentType,
              totalCostUsd: Number(s.total_cost_usd) || 0,
              messageCount: Number(s.message_count) || 0,
              startedAt: s.started_at as string,
            }))}
          />
        </section>
      )}

      {/* Team Cost Dashboard - Power tier + team membership only.
          WHY: Agencies and collaborative teams need to attribute AI spend to
          individual developers. This section is only meaningful when the user
          is on Power (which enables team features) AND has at least one team. */}
      {userTier === 'power' && teamId && (
        <TeamCosts teamId={teamId} rangeStartDate={rangeStartDate} />
      )}

      {/* Model pricing reference */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Model Pricing Reference
        </h2>
        <div className="rounded-xl bg-card/60 border border-border/40 overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead className="bg-secondary/40">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Model
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Input (per 1M)
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Output (per 1M)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {MODEL_PRICING.map((model) => (
                <tr key={model.name}>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {model.name}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground text-right">
                    ${model.inputPer1M.toFixed(model.inputPer1M < 1 ? 3 : 2)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground text-right">
                    ${model.outputPer1M.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground/60 mt-2">
          Prices last verified {LAST_VERIFIED}. Check provider websites for current pricing.
        </p>
      </section>
    </div>
  );
}
