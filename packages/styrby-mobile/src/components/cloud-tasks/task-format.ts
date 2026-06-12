/**
 * Cloud-task display config + formatting helpers.
 *
 * Pure constants + functions extracted from CloudTasks.tsx (Cluster A2 split)
 * so they can be unit-tested and shared by the sub-components.
 *
 * @module components/cloud-tasks/task-format
 */

import type { Ionicons } from '@expo/vector-icons';
import type { CloudTaskStatus, AgentType } from 'styrby-shared';

/** Visual config per task status (color-coding for at-a-glance scanning). */
export const STATUS_CONFIG: Record<
  CloudTaskStatus,
  { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  queued: { label: 'Queued', color: '#eab308', icon: 'time-outline' },
  running: { label: 'Running', color: '#3b82f6', icon: 'play-circle-outline' },
  completed: { label: 'Done', color: '#22c55e', icon: 'checkmark-circle-outline' },
  failed: { label: 'Failed', color: '#ef4444', icon: 'close-circle-outline' },
  cancelled: { label: 'Cancelled', color: '#71717a', icon: 'ban-outline' },
};

/** Accent color per agent type. */
export const AGENT_COLORS: Record<AgentType, string> = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
  opencode: '#8b5cf6',
  aider: '#ec4899',
  goose: '#06b6d4',
  amp: '#f59e0b',
  crush: '#f43f5e',
  kilo: '#84cc16',
  kiro: '#0ea5e9',
  droid: '#8b5cf6',
};

/**
 * Formats an ISO 8601 timestamp as a human-readable relative time.
 *
 * @param iso - ISO 8601 timestamp.
 * @returns e.g. "just now", "2 min ago", "3 hrs ago", "Yesterday".
 */
export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr${diffHr !== 1 ? 's' : ''} ago`;
  return 'Yesterday';
}

/**
 * Formats a USD cost.
 *
 * @param costUsd - Cost in dollars (may be undefined).
 * @returns e.g. "$0.0400", or '' when unknown.
 */
export function formatCost(costUsd?: number): string {
  if (costUsd === undefined) return '';
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Computes a running task's elapsed-percentage for the progress bar.
 *
 * @param startedAt - ISO 8601 start timestamp.
 * @param estimatedDurationMs - Estimated duration in ms (may be undefined).
 * @returns 0–95 (capped at 95 so a running bar never shows 100%).
 */
export function computeProgress(startedAt: string, estimatedDurationMs?: number): number {
  if (!estimatedDurationMs) return 0;
  const elapsed = Date.now() - new Date(startedAt).getTime();
  return Math.min(95, Math.round((elapsed / estimatedDurationMs) * 100));
}
