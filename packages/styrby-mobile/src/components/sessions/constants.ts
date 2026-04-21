/**
 * Sessions screen — visual config and filter chip definitions.
 *
 * WHY: Hoisting these constants out of the screen file keeps the
 * orchestrator focused on state + layout. The constants are referenced
 * by both SessionCard (status/agent labels) and the filter bar
 * (chip arrays), so a shared module avoids duplication.
 */

import type { AgentType } from 'styrby-shared';
import type { SessionFilters, DateRangeFilter } from '../../hooks/useSessions';

/**
 * Visual configuration for each supported AI agent.
 * Used for icon badges, background tints, and labels.
 */
export const AGENT_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  claude: { label: 'Claude', color: '#a855f7', icon: 'C' },
  codex: { label: 'Codex', color: '#22c55e', icon: 'X' },
  gemini: { label: 'Gemini', color: '#3b82f6', icon: 'G' },
};

/**
 * Look up agent display config, falling back to a neutral grey for
 * unknown agent types.
 *
 * @param agent - The agent_type string from the session row
 * @returns Config object with label, hex colour, and short icon letter
 */
export function getAgentConfig(agent: string) {
  return AGENT_CONFIG[agent] ?? { label: agent, color: '#71717a', icon: '?' };
}

/**
 * Map of session status to display colour.
 * Active statuses are green, terminal errors are red, and everything
 * else (completed/expired/paused) is a neutral grey.
 */
export const STATUS_COLORS: Record<string, string> = {
  starting: '#22c55e',
  running: '#22c55e',
  idle: '#22c55e',
  paused: '#eab308',
  stopped: '#71717a',
  error: '#ef4444',
  expired: '#71717a',
};

/**
 * Human-readable label for session statuses shown in the badge.
 */
export const STATUS_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Active',
  idle: 'Idle',
  paused: 'Paused',
  stopped: 'Completed',
  error: 'Error',
  expired: 'Expired',
};

/** Status filter options displayed as chips. */
export const STATUS_CHIPS: Array<{
  label: string;
  value: SessionFilters['status'];
}> = [
  { label: 'All', value: null },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
];

/** Agent filter options displayed as chips. */
export const AGENT_CHIPS: Array<{ label: string; value: AgentType | null }> = [
  { label: 'All', value: null },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
  { label: 'Gemini', value: 'gemini' },
];

/** Scope filter options for personal vs team sessions. */
export const SCOPE_CHIPS: Array<{
  label: string;
  value: 'mine' | 'team' | null;
}> = [
  { label: 'My Sessions', value: 'mine' },
  { label: 'Team Sessions', value: 'team' },
];

/** Date range filter options displayed as chips. */
export const DATE_RANGE_CHIPS: Array<{
  label: string;
  value: DateRangeFilter;
}> = [
  { label: 'All Time', value: 'all' },
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
];
