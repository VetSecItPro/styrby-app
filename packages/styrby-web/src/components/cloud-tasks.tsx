'use client';

/**
 * CloudTasksPanel Component
 *
 * Web dashboard panel for monitoring asynchronous cloud agent tasks.
 *
 * Features:
 * - Task list with status badges (queued, running, completed, failed, cancelled)
 * - Real-time status updates via Supabase Realtime subscription
 * - Inline result expansion for completed tasks
 * - Cancel button for queued/running tasks
 * - Cost display for completed tasks
 * - Empty state with CLI usage hint
 *
 * Orchestrator only (Cluster A2 split): data + realtime + cancel live in
 * `useCloudTasks`, the status tally + formatters + mapper in `task-format` /
 * `rowToTask`, and the badges + row in their own sub-components.
 *
 * WHY a separate panel component: The dashboard handles its own realtime
 * subscriptions for sessions and costs. Cloud tasks are scoped to this panel to
 * keep the dashboard small and allow standalone use on a dedicated page.
 *
 * @module components/cloud-tasks
 */

import { useMemo } from 'react';
import { useCloudTasks } from './cloud-tasks/useCloudTasks';
import { computeTaskStats } from './cloud-tasks/task-format';
import { TaskRow } from './cloud-tasks/TaskRow';
import type { CloudTasksPanelProps } from './cloud-tasks/types';

export type { CloudTasksPanelProps } from './cloud-tasks/types';

/**
 * Cloud tasks monitoring panel for the web dashboard.
 *
 * Loads the user's 20 most recent cloud tasks from Supabase and subscribes to
 * real-time updates. Shows a status overview and a task list.
 *
 * @param props - CloudTasksPanelProps containing the authenticated user ID.
 *
 * @example
 * <CloudTasksPanel userId={user.id} />
 */
export function CloudTasksPanel({ userId }: CloudTasksPanelProps) {
  const { tasks, isLoading, cancellingId, handleCancel } = useCloudTasks(userId);

  const stats = useMemo(() => computeTaskStats(tasks), [tasks]);

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Cloud Tasks</h2>
        {(stats.running > 0 || stats.queued > 0) && (
          <span className="flex items-center gap-1.5 text-xs text-blue-400">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            {stats.running} running · {stats.queued} queued
          </span>
        )}
      </div>

      {/* Stats row */}
      {tasks.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Running',   value: stats.running,   color: 'text-blue-400' },
            { label: 'Queued',    value: stats.queued,    color: 'text-yellow-400' },
            { label: 'Completed', value: stats.completed, color: 'text-green-400' },
            { label: 'Failed',    value: stats.failed,    color: 'text-red-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-zinc-900 rounded-lg p-3 text-center">
              <div className={`text-lg font-bold ${color}`}>{value}</div>
              <div className="text-xs text-zinc-400">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Task list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 rounded-full border-2 border-orange-500 border-t-transparent animate-spin" />
          <span className="ml-3 text-sm text-zinc-400">Loading tasks...</span>
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg
            className="w-12 h-12 text-zinc-700 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
            />
          </svg>
          <p className="text-sm text-zinc-400 mb-2">No cloud tasks yet</p>
          <p className="text-xs text-zinc-400 font-mono">
            styrby cloud submit &quot;Write tests for auth.ts&quot;
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onCancel={
                cancellingId !== task.id &&
                (task.status === 'queued' || task.status === 'running')
                  ? handleCancel
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {/* CLI hint */}
      <p className="text-xs text-zinc-400 text-center pt-1">
        Submit async tasks with{' '}
        <code className="font-mono text-zinc-400">styrby cloud submit</code>
      </p>
    </div>
  );
}
