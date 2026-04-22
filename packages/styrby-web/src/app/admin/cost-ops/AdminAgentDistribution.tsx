/**
 * AdminAgentDistribution — which agents users actually use.
 *
 * WHY this exists in founder dashboard: Knowing which agents drive sessions
 * informs agent prioritisation, support focus, and integration investment.
 *
 * @module app/admin/cost-ops/AdminAgentDistribution
 */

interface AgentUsage {
  agentType: string;
  sessionCount: number;
  pct: number;
}

interface AdminAgentDistributionProps {
  data: AgentUsage[];
}

/**
 * Agent colour map — mirrors the mobile costs screen agent colours.
 */
const AGENT_CLASS: Record<string, string> = {
  claude: 'bg-orange-500/80',
  codex: 'bg-green-500/80',
  gemini: 'bg-blue-500/80',
  opencode: 'bg-purple-500/80',
  aider: 'bg-pink-500/80',
  goose: 'bg-cyan-500/80',
  amp: 'bg-yellow-500/80',
  crush: 'bg-rose-500/80',
  kilo: 'bg-indigo-500/80',
  kiro: 'bg-teal-500/80',
  droid: 'bg-lime-500/80',
};

/**
 * Renders agent usage as a percentage bar list.
 *
 * @param props - Usage data sorted by session count descending
 * @returns Agent distribution element
 */
export function AdminAgentDistribution({ data }: AdminAgentDistributionProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-zinc-500 text-sm">
        No session data in last 90 days
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-2.5">
      {data.map((agent) => (
        <div key={agent.agentType}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-300 capitalize">{agent.agentType}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">{agent.sessionCount.toLocaleString()} sessions</span>
              <span className="text-xs font-semibold text-zinc-100 w-8 text-right">{agent.pct}%</span>
            </div>
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${AGENT_CLASS[agent.agentType] ?? 'bg-zinc-500/80'}`}
              style={{ width: `${agent.pct}%` }}
              role="progressbar"
              aria-valuenow={agent.pct}
              aria-valuemax={100}
              aria-label={`${agent.agentType}: ${agent.pct}%`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
