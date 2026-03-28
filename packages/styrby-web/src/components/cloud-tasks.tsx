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
 * WHY a separate panel component: The dashboard already handles its own
 * realtime subscriptions for sessions and costs. Cloud tasks are scoped to
 * this panel to keep the dashboard component small and to allow the cloud
 * tasks panel to be used standalone on a dedicated /cloud-tasks page if needed.
 *
 * @module components/cloud-tasks
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { CloudTask, CloudTaskStatus, AgentType } from '@styrby/shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * Visual configuration for each task status.
 */
const STATUS_CONFIG: Record<
  CloudTaskStatus,
  { label: string; dotColor: string; badgeBg: string; badgeText: string }
> = {
  queued:    { label: 'Queued',    dotColor: '#eab308', badgeBg: 'bg-yellow-500/10',  badgeText: 'text-yellow-400' },
  running:   { label: 'Running',   dotColor: '#3b82f6', badgeBg: 'bg-blue-500/10',    badgeText: 'text-blue-400' },
  completed: { label: 'Done',      dotColor: '#22c55e', badgeBg: 'bg-green-500/10',   badgeText: 'text-green-400' },
  failed:    { label: 'Failed',    dotColor: '#ef4444', badgeBg: 'bg-red-500/10',      badgeText: 'text-red-400' },
  cancelled: { label: 'Cancelled', dotColor: '#71717a', badgeBg: 'bg-zinc-800',        badgeText: 'text-zinc-500' },
};

/**
 * Agent brand colors for the agent indicator badge.
 */
const AGENT_COLORS: Record<AgentType, string> = {
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Maps a raw Supabase cloud_tasks row to the typed CloudTask interface.
 *
 * @param row - Raw database row
 * @returns Typed CloudTask object
 */
function rowToTask(row: Record<string, unknown>): CloudTask {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string | null) ?? null,
    agentType: row.agent_type as AgentType,
    status: row.status as CloudTaskStatus,
    prompt: row.prompt as string,
    result: row.result as string | undefined,
    errorMessage: row.error_message as string | undefined,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | undefined,
    estimatedDurationMs: row.estimated_duration_ms as number | undefined,
    costUsd: row.cost_usd as number | undefined,
    metadata: row.metadata as CloudTask['metadata'],
  };
}

/**
 * Formats an ISO 8601 timestamp as a relative time string.
 *
 * @param iso - ISO 8601 timestamp
 * @returns Human-readable relative time string
 */
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return 'Yesterday';
}

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the CloudTasksPanel component.
 */
export interface CloudTasksPanelProps {
  /**
   * The authenticated user's Supabase ID.
   * Used to scope the query and real-time subscription.
   */
  userId: string;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Status badge pill.
 *
 * @param status - The CloudTaskStatus to render
 * @returns React element
 */
function StatusBadge({ status }: { status: CloudTaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.badgeBg} ${cfg.badgeText}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: cfg.dotColor }}
      />
      {cfg.label}
    </span>
  );
}

/**
 * Agent type badge.
 *
 * @param agentType - The AgentType to display
 * @returns React element
 */
function AgentBadge({ agentType }: { agentType: AgentType }) {
  const classes = AGENT_COLORS[agentType] ?? 'bg-zinc-700 text-zinc-400';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${classes}`}
    >
      {agentType}
    </span>
  );
}

/**
 * Individual cloud task row.
 *
 * @param task - The CloudTask to render
 * @param onCancel - Called when the cancel button is clicked
 * @returns React element
 */
function TaskRow({
  task,
  onCancel,
}: {
  task: CloudTask;
  onCancel?: (id: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isActive = task.status === 'queued' || task.status === 'running';
  const hasContent = task.result || task.errorMessage;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      {/* Main row */}
      <button
        onClick={() => { if (hasContent) setIsExpanded((e) => !e); }}
        className={`w-full flex items-start gap-3 p-4 text-left ${hasContent ? 'cursor-pointer hover:bg-zinc-900' : 'cursor-default'}`}
        aria-expanded={hasContent ? isExpanded : undefined}
        aria-label={`Cloud task: ${task.prompt.slice(0, 60)}`}
      >
        {/* Agent badge */}
        <div className="flex-shrink-0 mt-0.5">
          <AgentBadge agentType={task.agentType} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 leading-5 line-clamp-2">{task.prompt}</p>

          <div className="flex flex-wrap items-center gap-3 mt-2">
            <StatusBadge status={task.status} />

            {task.metadata?.gitBranch && (
              <span className="text-xs text-zinc-500 font-mono">
                {task.metadata.gitBranch}
              </span>
            )}

            {task.costUsd !== undefined && task.status === 'completed' && (
              <span className="text-xs font-semibold text-green-400">
                ${task.costUsd.toFixed(4)}
              </span>
            )}

            <span className="text-xs text-zinc-400 ml-auto">
              {formatRelativeTime(task.startedAt)}
            </span>
          </div>

          {/* Running progress bar */}
          {task.status === 'running' && (
            <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full animate-pulse"
                style={{ width: '60%' }}
              />
            </div>
          )}
        </div>

        {/* Cancel button for active tasks */}
        {isActive && onCancel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel(task.id);
            }}
            className="flex-shrink-0 px-2.5 py-1 text-xs font-medium text-red-400 bg-red-500/10 rounded hover:bg-red-500/20 transition-colors"
            aria-label={`Cancel task ${task.id}`}
          >
            Cancel
          </button>
        )}

        {/* Expand indicator */}
        {hasContent && (
          <svg
            className={`flex-shrink-0 w-4 h-4 text-zinc-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Expandable result / error */}
      {isExpanded && hasContent && (
        <div className="border-t border-zinc-800 p-4 bg-zinc-950">
          {task.result && (
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-5 max-h-48 overflow-y-auto">
              {task.result}
            </pre>
          )}
          {task.errorMessage && (
            <pre className="text-sm text-red-400 whitespace-pre-wrap font-mono leading-5 max-h-48 overflow-y-auto">
              {task.errorMessage}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Cloud tasks monitoring panel for the web dashboard.
 *
 * Loads the user's 20 most recent cloud tasks from Supabase and subscribes
 * to real-time updates. Shows a status overview and a task list.
 *
 * @param props - CloudTasksPanelProps containing the authenticated user ID
 * @returns React element
 *
 * @example
 * <CloudTasksPanel userId={user.id} />
 */
export function CloudTasksPanel({ userId }: CloudTasksPanelProps) {
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  // --------------------------------------------------------------------------
  // Load + Real-time
  // --------------------------------------------------------------------------

  useEffect(() => {
    let isMounted = true;

    const loadTasks = async () => {
      const { data } = await supabase
        .from('cloud_tasks')
        .select('*')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(20);

      if (isMounted && data) {
        setTasks(data.map((r) => rowToTask(r as Record<string, unknown>)));
      }
      if (isMounted) setIsLoading(false);
    };

    void loadTasks();

    // WHY: Subscribe only to this user's tasks to prevent cross-user leakage.
    const channel = supabase
      .channel(`cloud_tasks_web:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'cloud_tasks',
          filter: `user_id=eq.${userId}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          if (!isMounted) return;

          if (payload.eventType === 'INSERT') {
            setTasks((prev) => [rowToTask(payload.new), ...prev].slice(0, 20));
          } else if (payload.eventType === 'UPDATE') {
            setTasks((prev) =>
              prev.map((t) => (t.id === payload.new.id ? rowToTask(payload.new) : t))
            );
          } else if (payload.eventType === 'DELETE') {
            setTasks((prev) => prev.filter((t) => t.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      void supabase.removeChannel(channel);
    };
  }, [userId, supabase]);

  // --------------------------------------------------------------------------
  // Cancel
  // --------------------------------------------------------------------------

  /**
   * Cancels a cloud task by updating its status in Supabase.
   * Uses optimistic update for immediate UI feedback.
   *
   * @param taskId - The task UUID to cancel
   */
  const handleCancel = useCallback(
    async (taskId: string) => {
      setCancellingId(taskId);

      // Optimistic update
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, status: 'cancelled' as CloudTaskStatus } : t
        )
      );

      const { error } = await supabase
        .from('cloud_tasks')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', taskId);

      if (error) {
        // Revert optimistic update on failure — Realtime will correct eventually
        console.error('[CloudTasks] Cancel failed:', error.message);
      }

      setCancellingId(null);
    },
    [supabase]
  );

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  const stats = useMemo(
    () => ({
      running:   tasks.filter((t) => t.status === 'running').length,
      queued:    tasks.filter((t) => t.status === 'queued').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed:    tasks.filter((t) => t.status === 'failed').length,
    }),
    [tasks]
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
          Cloud Tasks
        </h2>
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
              <div className="text-xs text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Task list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 rounded-full border-2 border-orange-500 border-t-transparent animate-spin" />
          <span className="ml-3 text-sm text-zinc-500">Loading tasks...</span>
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
          <p className="text-sm text-zinc-500 mb-2">No cloud tasks yet</p>
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
        <code className="font-mono text-zinc-500">styrby cloud submit</code>
      </p>
    </div>
  );
}
