/**
 * Display config + pure helpers for the web cloud-tasks panel.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split). The relative-time
 * formatter and the status tally were untestable inline; as pure functions
 * they can be verified directly. (Web-specific Tailwind classes, so this is not
 * shared with the mobile cloud-tasks helpers.)
 *
 * @module components/cloud-tasks/task-format
 */

import type { CloudTask, CloudTaskStatus, AgentType } from '@styrby/shared';

/** Visual configuration for each task status (badge color classes). */
export const STATUS_CONFIG: Record<
  CloudTaskStatus,
  { label: string; dotColor: string; badgeBg: string; badgeText: string }
> = {
  queued:    { label: 'Queued',    dotColor: '#eab308', badgeBg: 'bg-yellow-500/10', badgeText: 'text-yellow-400' },
  running:   { label: 'Running',   dotColor: '#3b82f6', badgeBg: 'bg-blue-500/10',   badgeText: 'text-blue-400' },
  completed: { label: 'Done',      dotColor: '#22c55e', badgeBg: 'bg-green-500/10',  badgeText: 'text-green-400' },
  failed:    { label: 'Failed',    dotColor: '#ef4444', badgeBg: 'bg-red-500/10',    badgeText: 'text-red-400' },
  cancelled: { label: 'Cancelled', dotColor: '#71717a', badgeBg: 'bg-zinc-800',      badgeText: 'text-zinc-400' },
};

/** Agent brand color classes for the agent indicator badge. */
export const AGENT_COLORS: Record<AgentType, string> = {
  claude:   'bg-orange-500/20 text-orange-400',
  codex:    'bg-green-500/20 text-green-400',
  gemini:   'bg-blue-500/20 text-blue-400',
  opencode: 'bg-purple-500/20 text-purple-400',
  aider:    'bg-pink-500/20 text-pink-400',
  goose:    'bg-cyan-500/20 text-cyan-400',
  amp:      'bg-amber-500/20 text-amber-400',
  crush:    'bg-rose-500/20 text-rose-400',
  kilo:     'bg-lime-500/20 text-lime-400',
  kiro:     'bg-sky-500/20 text-sky-400',
  droid:    'bg-violet-500/20 text-violet-400',
};

/**
 * Format an ISO 8601 timestamp as a relative time string.
 *
 * @param iso - ISO 8601 timestamp.
 * @returns Human-readable relative time (e.g. "just now", "5m ago", "Yesterday").
 */
export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return 'Yesterday';
}

/** Per-status counts shown in the stats row + header. */
export interface CloudTaskStats {
  running: number;
  queued: number;
  completed: number;
  failed: number;
}

/**
 * Tally tasks by status in a single O(n) pass.
 *
 * WHY single-pass reduce: the prior inline version did 4 sequential
 * `.filter().length` walks (O(4n)). One reduce yields the same shape in one
 * pass - this recomputes on every Realtime event, so it matters on dashboards
 * with many active tasks.
 *
 * @param tasks - The current task list.
 * @returns Counts for running/queued/completed/failed.
 */
export function computeTaskStats(tasks: CloudTask[]): CloudTaskStats {
  return tasks.reduce(
    (acc, t) => {
      if (t.status === 'running') acc.running++;
      else if (t.status === 'queued') acc.queued++;
      else if (t.status === 'completed') acc.completed++;
      else if (t.status === 'failed') acc.failed++;
      return acc;
    },
    { running: 0, queued: 0, completed: 0, failed: 0 },
  );
}
