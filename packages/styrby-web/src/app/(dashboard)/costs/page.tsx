import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CostCharts } from './cost-charts';

/**
 * Cost Analytics page - displays spending data and charts.
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
    .gte('created_at', thirtyDaysAgo.toISOString());

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

  // Calculate monthly total
  const monthlyTotal = Object.values(agentTotals).reduce((sum, a) => sum + a.cost, 0);

  // Prepare chart data
  const chartData = (dailyCosts || []).map((day) => ({
    date: day.date,
    total: Number(day.total_cost_usd) || 0,
    claude: Number(day.claude_cost_usd) || 0,
    codex: Number(day.codex_cost_usd) || 0,
    gemini: Number(day.gemini_cost_usd) || 0,
  }));

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
          <h1 className="text-2xl font-bold text-zinc-100">Cost Analytics</h1>

          {/* Time range selector */}
          <select className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500">
            <option value="30">Last 30 days</option>
            <option value="7">Last 7 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          {/* Monthly total */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <p className="text-sm text-zinc-500">Monthly Total</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">
              ${monthlyTotal.toFixed(2)}
            </p>
          </div>

          {/* Per-agent cards */}
          {(['claude', 'codex', 'gemini'] as const).map((agent) => {
            const data = agentTotals[agent] || { cost: 0, inputTokens: 0, outputTokens: 0 };
            return (
              <div
                key={agent}
                className="rounded-xl bg-zinc-900 border border-zinc-800 p-4"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-3 w-3 rounded-full ${
                      agent === 'claude'
                        ? 'bg-orange-500'
                        : agent === 'codex'
                          ? 'bg-green-500'
                          : 'bg-blue-500'
                    }`}
                  />
                  <p className="text-sm text-zinc-500 capitalize">{agent}</p>
                </div>
                <p className="text-2xl font-bold text-zinc-100 mt-1">
                  ${data.cost.toFixed(2)}
                </p>
                <p className="text-xs text-zinc-600 mt-1">
                  {((data.inputTokens + data.outputTokens) / 1000).toFixed(1)}K tokens
                </p>
              </div>
            );
          })}
        </div>

        {/* Charts */}
        <CostCharts data={chartData} />

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
                {/* Claude models */}
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">
                    Claude 3.5 Sonnet
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $3.00
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $15.00
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">
                    Claude 3.5 Haiku
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $0.80
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $4.00
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">
                    Claude 3 Opus
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $15.00
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $75.00
                  </td>
                </tr>
                {/* OpenAI models */}
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">GPT-4o</td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $2.50
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $10.00
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">o1</td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $15.00
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $60.00
                  </td>
                </tr>
                {/* Gemini models */}
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">
                    Gemini 1.5 Pro
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $1.25
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $5.00
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-100">
                    Gemini 1.5 Flash
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $0.075
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400 text-right">
                    $0.30
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            Prices as of February 2026. Check provider websites for current pricing.
          </p>
        </section>
      </main>
    </div>
  );
}
