'use client';

import { useRouter } from 'next/navigation';
import type { AgentConfig } from './types';

/** Props for the Agent Settings section. */
export interface SettingsAgentsProps {
  /** Per-agent config rows (null if the user has never launched an agent). */
  agentConfigs: AgentConfig[] | null;
}

/**
 * Static list of the agents shown in this quick-summary section.
 *
 * WHY only 3 agents (not all 11): This surface is a shortcut into per-agent
 * configuration for the most common volume-tier agents. The full agents
 * dashboard at /dashboard/agents is the canonical place for all 11.
 */
const AGENT_ROWS: Array<{
  id: string;
  bg: string;
  fg: string;
}> = [
  { id: 'claude', bg: 'bg-orange-500/10', fg: 'text-orange-400' },
  { id: 'codex', bg: 'bg-green-500/10', fg: 'text-green-400' },
  { id: 'gemini', bg: 'bg-blue-500/10', fg: 'text-blue-400' },
];

/**
 * Agent Settings section: quick status for Claude/Codex/Gemini with a
 * "Configure" link into the agents dashboard.
 */
export function SettingsAgents({ agentConfigs }: SettingsAgentsProps) {
  const router = useRouter();
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Agent Settings</h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
        {AGENT_ROWS.map(({ id, bg, fg }) => {
          const config = agentConfigs?.find((c) => c.agent_type === id);
          return (
            <div key={id} className="px-4 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${bg}`}>
                  <span className={`text-sm font-bold ${fg}`}>{id[0].toUpperCase()}</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-100 capitalize">{id}</p>
                  <p className="text-sm text-zinc-500">
                    {config?.auto_approve_low_risk
                      ? 'Auto-approve low risk'
                      : 'Manual approval'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => router.push(`/dashboard/agents?agent=${id}`)}
                className="text-sm text-orange-500 hover:text-orange-400"
                aria-label={`Configure ${id} agent`}
              >
                Configure
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
