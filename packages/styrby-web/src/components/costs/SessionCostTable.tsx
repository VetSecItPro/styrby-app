'use client';

/**
 * SessionCostTable — lists top sessions by cost with drill-in capability.
 *
 * Renders a table of sessions sorted by total cost descending.
 * Each row has a "View breakdown" button that opens {@link SessionCostDrillIn}.
 *
 * WHY separate from CostTable: CostTable is model-level aggregation.
 * SessionCostTable is session-level with drill-in navigation. Different
 * data shapes and different UX patterns.
 *
 * @module components/costs/SessionCostTable
 */

import { SessionCostDrillIn } from './SessionCostDrillIn';
import type { AgentType } from '@/lib/costs';

// ============================================================================
// Types
// ============================================================================

/**
 * A session row for display in the cost table.
 */
export interface SessionCostRow {
  /** Session UUID */
  id: string;
  /** Short label — title or truncated summary */
  label: string;
  /** Agent type used */
  agentType: AgentType;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Number of messages/turns */
  messageCount: number;
  /** ISO start time */
  startedAt: string;
}

/**
 * Props for {@link SessionCostTable}.
 */
interface SessionCostTableProps {
  /** Sessions sorted by cost descending */
  sessions: SessionCostRow[];
  /** Section title */
  title?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Agent badge colour classes */
const AGENT_BADGE: Record<string, string> = {
  claude: 'bg-orange-500/10 text-orange-400',
  codex: 'bg-green-500/10 text-green-400',
  gemini: 'bg-blue-500/10 text-blue-400',
  opencode: 'bg-purple-500/10 text-purple-400',
  aider: 'bg-pink-500/10 text-pink-400',
  goose: 'bg-cyan-500/10 text-cyan-400',
  amp: 'bg-yellow-500/10 text-yellow-400',
  crush: 'bg-rose-500/10 text-rose-400',
  kilo: 'bg-indigo-500/10 text-indigo-400',
  kiro: 'bg-teal-500/10 text-teal-400',
  droid: 'bg-lime-500/10 text-lime-400',
};

/**
 * Format a date to a short human-readable string.
 *
 * @param iso - ISO 8601 date string
 * @returns Short date, e.g. "Apr 21"
 */
function fmtDate(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(iso);
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a table of sessions by cost with per-session drill-in capability.
 *
 * @param props - Table data + optional title
 * @returns Table element with drill-in modals
 *
 * @example
 * <SessionCostTable
 *   sessions={topSessions}
 *   title="Top Sessions by Cost"
 * />
 */
export function SessionCostTable({
  sessions,
  title = 'Top Sessions by Cost',
}: SessionCostTableProps) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-xl bg-card/60 border border-border/40 px-4 py-8 text-center">
        <p className="text-muted-foreground text-sm">No sessions in this period</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/50">
            <tr>
              {['Date', 'Session', 'Agent', 'Messages', 'Cost', ''].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {sessions.map((session) => (
              <tr key={session.id} className="hover:bg-zinc-800/30 transition-colors">
                {/* Date */}
                <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">
                  {fmtDate(session.startedAt)}
                </td>

                {/* Label */}
                <td className="px-4 py-3 max-w-[200px]">
                  <p className="text-xs text-zinc-300 truncate" title={session.label}>
                    {session.label}
                  </p>
                </td>

                {/* Agent */}
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      AGENT_BADGE[session.agentType] ?? 'bg-zinc-500/10 text-zinc-400'
                    }`}
                  >
                    {session.agentType}
                  </span>
                </td>

                {/* Messages */}
                <td className="px-4 py-3 text-xs text-zinc-500 text-right">
                  {session.messageCount.toLocaleString()}
                </td>

                {/* Cost */}
                <td className="px-4 py-3 text-xs font-semibold text-zinc-100 text-right whitespace-nowrap">
                  ${session.totalCostUsd.toFixed(4)}
                </td>

                {/* Drill-in */}
                <td className="px-4 py-3 text-right">
                  <SessionCostDrillIn
                    sessionId={session.id}
                    sessionLabel={session.label}
                  >
                    <button
                      type="button"
                      className="text-xs text-zinc-500 hover:text-orange-400 transition-colors whitespace-nowrap"
                    >
                      View breakdown
                    </button>
                  </SessionCostDrillIn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
