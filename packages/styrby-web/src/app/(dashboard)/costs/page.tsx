import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CostCharts } from './cost-charts';
import { CostsRealtime } from './costs-realtime';
import { BudgetAlertsSummary } from './budget-alerts-summary';
import { TIERS, type TierId } from '@/lib/polar';
import { MODEL_PRICING, LAST_VERIFIED } from '@/lib/model-pricing';

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
export default async function CostsPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch daily cost summary (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: dailyCosts } = await supabase
    .from('mv_daily_cost_summary')
    .select('*')
    .gte('date', thirtyDaysAgo.toISOString().split('T')[0])
    .order('date', { ascending: true });

  // Fetch cost records for per-agent breakdown
  const { data: agentCosts } = await supabase
    .from('cost_records')
    .select('agent_type, model, cost_usd, input_tokens, output_tokens')
    .gte('created_at', thirtyDaysAgo.toISOString())
    .limit(10000);

  // Calculate totals by agent
  const agentTotals = (agentCosts || []).reduce(
    (acc, record) => {
      const agent = record.agent_type || 'unknown';
      if (!acc[agent]) {
        acc[agent] = { cost: 0, inputTokens: 0, outputTokens: 0 };
      }
      acc[agent].cost += Number(record.cost_usd) || 0;
      acc[agent].inputTokens += record.input_tokens || 0;
      acc[agent].outputTokens += record.output_tokens || 0;
      return acc;
    },
    {} as Record<string, { cost: number; inputTokens: number; outputTokens: number }>
  );

  // Calculate totals by model
  const modelTotals = (agentCosts || []).reduce(
    (acc, record) => {
      const model = record.model || 'unknown';
      if (!acc[model]) {
        acc[model] = { cost: 0, requests: 0 };
      }
      acc[model].cost += Number(record.cost_usd) || 0;
      acc[model].requests += 1;
      return acc;
    },
    {} as Record<string, { cost: number; requests: number }>
  );

  // NOTE: Monthly total is computed inside CostsRealtime from agentTotals

  // Prepare chart data
  const chartData = (dailyCosts || []).map((day) => ({
    date: day.date,
    total: Number(day.total_cost_usd) || 0,
    claude: Number(day.claude_cost_usd) || 0,
    codex: Number(day.codex_cost_usd) || 0,
    gemini: Number(day.gemini_cost_usd) || 0,
  }));

  // Fetch budget alerts summary data for the widget
  // WHY: We fetch alerts here instead of in a separate component because
  // this is a server component and we already have the authenticated Supabase client.
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

  /**
   * Calculates the start of the current period for spend aggregation.
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

  // WHY: We compute the "most critical" alert (highest % used) to show in the
  // summary widget. This gives users an at-a-glance view of their closest alert.
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
    const alertsWithSpend = await Promise.all(
      budgetAlerts.map(async (alert) => {
        const periodStart = getPeriodStartDate(alert.period);
        let query = supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', user.id)
          .gte('recorded_at', periodStart);

        if (alert.agent_type) {
          query = query.eq('agent_type', alert.agent_type);
        }

        const { data: costData } = await query;
        const currentSpend = (costData || []).reduce(
          (sum, r) => sum + (Number(r.cost_usd) || 0),
          0
        );
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
      })
    );

    // Sort by percentage used descending, pick the most critical
    alertsWithSpend.sort((a, b) => b.percentage_used - a.percentage_used);
    mostCriticalAlert = alertsWithSpend[0];
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link href="/costs" className="text-sm font-medium text-orange-500">
                Costs
              </Link>
              <Link
                href="/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold text-zinc-100">Cost Analytics</h1>
            <Link
              href="/costs/budget-alerts"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors flex items-center gap-1.5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              Budget Alerts
            </Link>
          </div>

          {/* Time range selector */}
          <select className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500">
            <option value="30">Last 30 days</option>
            <option value="7">Last 7 days</option>
            <option value="90">Last 90 days</option>
          </select>
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

        {/* Model breakdown */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Cost by Model
          </h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
            {Object.entries(modelTotals)
              .sort(([, a], [, b]) => b.cost - a.cost)
              .map(([model, data]) => (
                <div
                  key={model}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-zinc-100">{model}</p>
                    <p className="text-xs text-zinc-500">
                      {data.requests.toLocaleString()} requests
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-zinc-100">
                    ${data.cost.toFixed(4)}
                  </p>
                </div>
              ))}
            {Object.keys(modelTotals).length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-zinc-500">No usage data yet</p>
              </div>
            )}
          </div>
        </section>

        {/* Model pricing reference */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Model Pricing Reference
          </h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
            <table className="w-full">
              <thead className="bg-zinc-800/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Model
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Input (per 1M)
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Output (per 1M)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {MODEL_PRICING.map((model) => (
                  <tr key={model.name}>
                    <td className="px-4 py-3 text-sm text-zinc-100">
                      {model.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                      ${model.inputPer1M.toFixed(model.inputPer1M < 1 ? 3 : 2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                      ${model.outputPer1M.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            Prices last verified {LAST_VERIFIED}. Check provider websites for current pricing.
          </p>
        </section>
      </main>
    </div>
  );
}
