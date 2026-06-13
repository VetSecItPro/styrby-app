/**
 * AgentBadge — agent-type pill for a cloud task.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/AgentBadge
 */

import type { AgentType } from '@styrby/shared';
import { AGENT_COLORS } from './task-format';

/**
 * Agent type badge.
 *
 * @param agentType - The AgentType to display.
 */
export function AgentBadge({ agentType }: { agentType: AgentType }) {
  const classes = AGENT_COLORS[agentType] ?? 'bg-zinc-700 text-zinc-300';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${classes}`}
    >
      {agentType}
    </span>
  );
}
