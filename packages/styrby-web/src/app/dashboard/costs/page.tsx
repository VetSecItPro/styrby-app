// WHY: force-dynamic ensures this page is always server-rendered at request time.
// Cost analytics are user-specific and update continuously during active sessions —
// a cached response would show incorrect spend totals and stale budget alert state.
export const dynamic = 'force-dynamic';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CostCharts } from './cost-charts';
import { CostsRealtime } from './costs-realtime';
import { BudgetAlertsSummary } from './budget-alerts-summary';
import { TokenUsageSummary } from './token-usage-summary';
import { TimeRangeSelect } from './time-range-select';
import { TIERS, type TierId } from '@/lib/polar';
import { MODEL_PRICING, LAST_VERIFIED } from '@/lib/model-pricing';

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

  // Fetch daily cost summary — includes agent_type and model dimensions.
  // WHY: After migration 010, mv_daily_cost_summary groups by (user_id, record_date,
  // agent_type, model). A single MV query now provides all data needed for the daily
  // trend chart, per-agent breakdown, and per-model breakdown — eliminating the
  // separate raw cost_records table scan that previously fetched up to 10,000 rows.
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - days);
  const rangeStartDate = rangeStart.toISOString().split('T')[0];

  const { data: mvRows } = await supabase
    .from('mv_daily_cost_summary')
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

  const [alertsResult, subscriptionResult] = await Promise.all([
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
  ]);

  const budgetAlerts = alertsResult.data || [];
  const userTier = (subscriptionResult.data?.tier as TierId) || 'free';
  const alertLimit = TIERS[userTier]?.limits.budgetAlerts ?? 0;

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
        </div>

        {/* Time range selector — client component for onChange interactivity */}
        <TimeRangeSelect currentDays={days} />
      </div>

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

        {/* Charts */}
        <CostCharts data={chartData} />
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
