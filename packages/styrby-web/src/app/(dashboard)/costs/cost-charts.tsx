'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

interface ChartDataPoint {
  date: string;
  total: number;
  claude: number;
  codex: number;
  gemini: number;
}

interface CostChartsProps {
  data: ChartDataPoint[];
}

const AGENT_COLORS = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
};

/**
 * Client-side cost charts using Recharts.
 */
export function CostCharts({ data }: CostChartsProps) {
  // Format date for display
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Calculate totals for pie chart
  const totals = data.reduce(
    (acc, day) => ({
      claude: acc.claude + day.claude,
      codex: acc.codex + day.codex,
      gemini: acc.gemini + day.gemini,
    }),
    { claude: 0, codex: 0, gemini: 0 }
  );

  const pieData = [
    { name: 'Claude', value: totals.claude, color: AGENT_COLORS.claude },
    { name: 'Codex', value: totals.codex, color: AGENT_COLORS.codex },
    { name: 'Gemini', value: totals.gemini, color: AGENT_COLORS.gemini },
  ].filter((d) => d.value > 0);

  const hasData = data.length > 0;

  if (!hasData) {
    return (
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
          <svg
            className="h-6 w-6 text-zinc-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-zinc-100">No cost data yet</h3>
        <p className="mt-2 text-zinc-500">
          Start using your AI agents to see cost analytics here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Daily spending trend */}
      <section>
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Daily Spending
        </h2>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data}>
              <defs>
                <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                stroke="#71717a"
                fontSize={12}
              />
              <YAxis
                stroke="#71717a"
                fontSize={12}
                tickFormatter={(value) => `$${value.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#fafafa' }}
                itemStyle={{ color: '#a1a1aa' }}
                formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
                labelFormatter={(label) => formatDate(label)}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#f97316"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorTotal)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Spending by agent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Stacked bar chart */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Daily Breakdown by Agent
          </h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#71717a"
                  fontSize={12}
                />
                <YAxis
                  stroke="#71717a"
                  fontSize={12}
                  tickFormatter={(value) => `$${value.toFixed(2)}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#18181b',
                    border: '1px solid #27272a',
                    borderRadius: '8px',
                  }}
                  labelStyle={{ color: '#fafafa' }}
                  formatter={(value: number) => `$${value.toFixed(4)}`}
                  labelFormatter={(label) => formatDate(label)}
                />
                <Legend
                  wrapperStyle={{ paddingTop: '20px' }}
                  formatter={(value) => (
                    <span className="text-zinc-400 capitalize">{value}</span>
                  )}
                />
                <Bar
                  dataKey="claude"
                  stackId="a"
                  fill={AGENT_COLORS.claude}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="codex"
                  stackId="a"
                  fill={AGENT_COLORS.codex}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="gemini"
                  stackId="a"
                  fill={AGENT_COLORS.gemini}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Pie chart */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Total by Agent
          </h2>
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} ${(percent * 100).toFixed(0)}%`
                  }
                  labelLine={{ stroke: '#71717a' }}
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#18181b',
                    border: '1px solid #27272a',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number) => `$${value.toFixed(4)}`}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Legend below pie chart */}
            <div className="flex justify-center gap-6 mt-4">
              {pieData.map((entry) => (
                <div key={entry.name} className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-sm text-zinc-400">{entry.name}</span>
                  <span className="text-sm font-medium text-zinc-100">
                    ${entry.value.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
