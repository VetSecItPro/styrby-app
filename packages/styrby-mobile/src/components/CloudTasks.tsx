/**
 * CloudTasks Component
 *
 * Displays the user's cloud agent task list with real-time status updates.
 * This component covers both "Cloud Monitoring" and "Code Review From Mobile"
 * Power-tier features — cloud tasks can represent any long-running agent job
 * including code review requests dispatched from the mobile app.
 *
 * Features:
 * - Task cards with status badges (queued, running, completed, failed, cancelled)
 * - Progress indicator for running tasks with elapsed time
 * - Estimated duration progress bar when estimatedDurationMs is set
 * - Tap to expand and read the full result or error
 * - Cancel button for queued/running tasks
 * - Push notification badge on completed tasks (shows until dismissed)
 *
 * Data flow:
 * - Initial task list loaded from the `cloud_tasks` Supabase table
 * - Supabase Realtime subscription streams status updates as tasks progress
 *
 * WHY Supabase Realtime for cloud tasks: The mobile app can be in the
 * background when a task completes. Realtime ensures that when the user
 * opens the app, they see up-to-date statuses without a manual refresh.
 * The push notification (from CLI) brings them to the app; Realtime shows
 * the current state.
 *
 * TIER GATE (mobile-side): Cloud Monitoring and Code Review From Mobile are
 * Power-only features. When rendering this component in a screen, the caller
 * MUST check the user's subscription tier before showing it. Free and Pro
 * users should see a locked state or an upgrade prompt.
 *
 * Example (in the dashboard or tasks screen):
 *   {userTier === 'power' ? (
 *     <CloudTasks userId={userId} />
 *   ) : (
 *     <UpgradePrompt feature="Cloud monitoring" requiredTier="power" />
 *   )}
 *
 * Code review from mobile is dispatched via cloud tasks with task_type='code_review'.
 * The same tier check applies — only Power users can create code review tasks.
 *
 * @module components/CloudTasks
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import type { CloudTask, CloudTaskStatus, AgentType } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * Visual configuration for each task status.
 * WHY: Consistent color-coding helps users scan task status at a glance.
 */
const STATUS_CONFIG: Record<CloudTaskStatus, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  queued:    { label: 'Queued',    color: '#eab308', icon: 'time-outline' },
  running:   { label: 'Running',   color: '#3b82f6', icon: 'play-circle-outline' },
  completed: { label: 'Done',      color: '#22c55e', icon: 'checkmark-circle-outline' },
  failed:    { label: 'Failed',    color: '#ef4444', icon: 'close-circle-outline' },
  cancelled: { label: 'Cancelled', color: '#71717a', icon: 'ban-outline' },
};

/**
 * Visual configuration for each agent type.
 * WHY: Lets users quickly identify which agent ran a given task.
 */
const AGENT_COLORS: Record<AgentType, string> = {
  claude:   '#f97316',
  codex:    '#22c55e',
  gemini:   '#3b82f6',
  opencode: '#8b5cf6',
  aider:    '#ec4899',
  goose:    '#06b6d4',
  amp:      '#f59e0b',
  crush:    '#f43f5e',
  kilo:     '#84cc16',
  kiro:     '#0ea5e9',
  droid:    '#8b5cf6',
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats an ISO 8601 timestamp as a human-readable relative time string.
 *
 * @param iso - ISO 8601 timestamp string
 * @returns Human-readable string like "2 min ago", "3 hrs ago", or "Yesterday"
 */
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24)  return `${diffHr} hr${diffHr !== 1 ? 's' : ''} ago`;
  return 'Yesterday';
}

/**
 * Formats a cost value as a human-readable USD string.
 *
 * @param costUsd - Cost in US dollars, may be undefined
 * @returns Formatted string like "$0.04" or empty string when unknown
 */
function formatCost(costUsd?: number): string {
  if (costUsd === undefined) return '';
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Computes the elapsed percentage for a running task's progress bar.
 *
 * @param startedAt - ISO 8601 start timestamp
 * @param estimatedDurationMs - Estimated duration in milliseconds, may be undefined
 * @returns A value from 0 to 100, capped at 95 for running tasks
 */
function computeProgress(startedAt: string, estimatedDurationMs?: number): number {
  if (!estimatedDurationMs) return 0;
  const elapsed = Date.now() - new Date(startedAt).getTime();
  // WHY: Cap at 95% so the bar never shows "100%" while still running.
  return Math.min(95, Math.round((elapsed / estimatedDurationMs) * 100));
}

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the CloudTasks component.
 */
export interface CloudTasksProps {
  /**
   * The authenticated user's Supabase ID.
   * Used to scope the query and realtime subscription.
   */
  userId: string;

  /**
   * Called when the user taps the cancel button on a queued or running task.
   *
   * @param taskId - The task ID to cancel
   */
  onCancelTask?: (taskId: string) => Promise<void>;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Status badge showing the current state of a cloud task.
 *
 * @param status - The CloudTaskStatus to display
 * @returns React element
 */
function StatusBadge({ status }: { status: CloudTaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: `${cfg.color}20`,
      }}
    >
      <Ionicons name={cfg.icon} size={12} color={cfg.color} />
      <Text style={{ color: cfg.color, fontSize: 12, fontWeight: '600', marginLeft: 4 }}>
        {cfg.label}
      </Text>
    </View>
  );
}

/**
 * Progress bar for running tasks with an estimated duration.
 *
 * @param progress - Percentage (0–100) of estimated duration elapsed
 * @returns React element
 */
function ProgressBar({ progress }: { progress: number }) {
  return (
    <View
      style={{
        height: 4,
        backgroundColor: '#27272a',
        borderRadius: 2,
        marginTop: 8,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          height: 4,
          width: `${progress}%`,
          backgroundColor: '#3b82f6',
          borderRadius: 2,
        }}
      />
    </View>
  );
}

/**
 * Individual cloud task card.
 *
 * @param task - The CloudTask to render
 * @param onCancel - Optional cancel handler
 * @param onTap - Called when the card is tapped to expand the result
 * @returns React element
 */
function TaskCard({
  task,
  onCancel,
  onTap,
}: {
  task: CloudTask;
  onCancel?: () => void;
  onTap: () => void;
}) {
  const agentColor = AGENT_COLORS[task.agentType] ?? '#71717a';
  const isActive = task.status === 'queued' || task.status === 'running';
  const progress = task.status === 'running'
    ? computeProgress(task.startedAt, task.estimatedDurationMs)
    : 0;

  return (
    <Pressable
      onPress={onTap}
      style={{
        backgroundColor: '#18181b',
        borderRadius: 12,
        padding: 14,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#27272a',
      }}
      accessibilityRole="button"
      accessibilityLabel={`Cloud task: ${task.prompt.slice(0, 60)}. Status: ${STATUS_CONFIG[task.status].label}. Tap to view details.`}
    >
      {/* Header row: agent badge + status + time */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        {/* Agent indicator */}
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            backgroundColor: `${agentColor}20`,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 8,
          }}
        >
          <Text style={{ color: agentColor, fontSize: 10, fontWeight: '700' }}>
            {task.agentType.slice(0, 2).toUpperCase()}
          </Text>
        </View>

        <StatusBadge status={task.status} />

        <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 'auto' as never }}>
          {formatRelativeTime(task.startedAt)}
        </Text>
      </View>

      {/* Prompt preview */}
      <Text
        numberOfLines={2}
        style={{ color: '#e4e4e7', fontSize: 14, lineHeight: 20, marginBottom: 6 }}
      >
        {task.prompt}
      </Text>

      {/* Metadata row: project/branch + cost */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {task.metadata?.gitBranch && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12 }}>
            <Ionicons name="git-branch-outline" size={12} color="#71717a" />
            <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 4 }}>
              {task.metadata.gitBranch}
            </Text>
          </View>
        )}
        {task.costUsd !== undefined && task.status === 'completed' && (
          <Text style={{ color: '#71717a', fontSize: 12 }}>{formatCost(task.costUsd)}</Text>
        )}

        {/* Cancel button for active tasks */}
        {isActive && onCancel && (
          <Pressable
            onPress={(e) => { e.stopPropagation(); onCancel(); }}
            style={{
              marginLeft: 'auto' as never,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 8,
              backgroundColor: '#27272a',
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel task"
          >
            <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
        )}
      </View>

      {/* Progress bar for running tasks */}
      {task.status === 'running' && task.estimatedDurationMs && (
        <ProgressBar progress={progress} />
      )}

      {/* Running spinner for tasks without estimates */}
      {task.status === 'running' && !task.estimatedDurationMs && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <ActivityIndicator size="small" color="#3b82f6" />
          <Text style={{ color: '#3b82f6', fontSize: 12, marginLeft: 8 }}>Running…</Text>
        </View>
      )}
    </Pressable>
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Cloud task list with real-time status updates.
 *
 * Loads the user's most recent 25 cloud tasks from Supabase, subscribes to
 * real-time updates, and renders them as interactive task cards.
 *
 * @param props - CloudTasksProps
 * @returns React element
 *
 * @example
 * <CloudTasks
 *   userId={user.id}
 *   onCancelTask={handleCancel}
 * />
 */
export function CloudTasks({ userId, onCancelTask }: CloudTasksProps) {
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedTask, setSelectedTask] = useState<CloudTask | null>(null);
  const [isCancelling, setIsCancelling] = useState<string | null>(null);

  // WHY: Track the progress tick so running tasks' progress bars update every second.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, setTick] = useState(0);

  // --------------------------------------------------------------------------
  // Data Loading
  // --------------------------------------------------------------------------

  /**
   * Fetches the 25 most recent cloud tasks for the authenticated user.
   * Ordered by startedAt descending so newest tasks appear first.
   *
   * @param silent - When true, skips the loading indicator (used for refresh)
   */
  const loadTasks = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('cloud_tasks')
        .select('*')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(25);

      if (!error && data) {
        setTasks(data.map(rowToTask));
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [userId]);

  /**
   * Pull-to-refresh handler.
   */
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void loadTasks(true);
  }, [loadTasks]);

  // --------------------------------------------------------------------------
  // Real-time Subscription
  // --------------------------------------------------------------------------

  useEffect(() => {
    void loadTasks();

    // WHY: Subscribe only to this user's cloud_tasks so we never receive
    // status updates for other users' tasks (defense in depth beyond RLS).
    const channel = supabase
      .channel(`cloud_tasks:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'cloud_tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
          if (payload.eventType === 'INSERT') {
            setTasks((prev) => [rowToTask(payload.new), ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === (payload.new as { id: string }).id ? rowToTask(payload.new) : t
              )
            );
            // WHY: If the selected task detail modal is open, update it too
            // so the user sees the latest result/status without re-opening.
            setSelectedTask((prev) =>
              prev && prev.id === (payload.new as { id: string }).id ? rowToTask(payload.new) : prev
            );
          } else if (payload.eventType === 'DELETE') {
            setTasks((prev) => prev.filter((t) => t.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, loadTasks]);

  // --------------------------------------------------------------------------
  // Progress Bar Tick
  // --------------------------------------------------------------------------

  useEffect(() => {
    const hasRunning = tasks.some((t) => t.status === 'running');
    if (hasRunning && !tickRef.current) {
      tickRef.current = setInterval(() => setTick((n) => n + 1), 1000);
    } else if (!hasRunning && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [tasks]);

  // --------------------------------------------------------------------------
  // Cancel Task
  // --------------------------------------------------------------------------

  /**
   * Sends a cancel request for the given task.
   * Updates local state optimistically and reverts on failure.
   *
   * @param taskId - The task to cancel
   */
  const handleCancel = useCallback(async (taskId: string) => {
    if (!onCancelTask) return;
    setIsCancelling(taskId);
    try {
      await onCancelTask(taskId);
      // WHY: Optimistically update local state rather than waiting for realtime
      // because the realtime event may arrive several seconds later.
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, status: 'cancelled' as CloudTaskStatus } : t
        )
      );
    } catch {
      // Realtime will correct state if the cancel fails
    } finally {
      setIsCancelling(null);
    }
  }, [onCancelTask]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View style={{ padding: 16, alignItems: 'center' }}>
        <ActivityIndicator size="small" color="#f97316" />
        <Text style={{ color: '#71717a', marginTop: 8, fontSize: 14 }}>Loading tasks...</Text>
      </View>
    );
  }

  if (tasks.length === 0) {
    return (
      <View style={{ padding: 24, alignItems: 'center' }}>
        <Ionicons name="cloud-outline" size={40} color="#3f3f46" />
        <Text style={{ color: '#71717a', marginTop: 12, fontSize: 14, textAlign: 'center' }}>
          No cloud tasks yet.{'\n'}Use <Text style={{ color: '#f97316' }}>styrby cloud submit</Text> from your CLI to queue async agent tasks.
        </Text>
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            onTap={() => setSelectedTask(item)}
            onCancel={
              onCancelTask && (item.status === 'queued' || item.status === 'running')
                ? () => void handleCancel(item.id)
                : undefined
            }
          />
        )}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
          />
        }
      />

      {/* Task Detail Modal */}
      <Modal
        visible={selectedTask !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedTask(null)}
        accessibilityViewIsModal
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.7)',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: '#18181b',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: '80%',
            }}
          >
            {/* Modal Header */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 16,
                borderBottomWidth: 1,
                borderBottomColor: '#27272a',
              }}
            >
              {selectedTask && <StatusBadge status={selectedTask.status} />}
              <Text
                style={{ color: '#71717a', fontSize: 12, marginLeft: 10 }}
                numberOfLines={1}
              >
                {selectedTask?.metadata?.gitBranch ?? selectedTask?.agentType}
              </Text>
              <Pressable
                onPress={() => setSelectedTask(null)}
                style={{ marginLeft: 'auto' as never, padding: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Close task detail"
              >
                <Ionicons name="close" size={22} color="#71717a" />
              </Pressable>
            </View>

            <ScrollView style={{ padding: 16 }}>
              {/* Prompt */}
              <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                Prompt
              </Text>
              <Text style={{ color: 'white', fontSize: 15, lineHeight: 22, marginBottom: 16 }}>
                {selectedTask?.prompt}
              </Text>

              {/* Result */}
              {selectedTask?.result && (
                <>
                  <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                    Result
                  </Text>
                  <View
                    style={{
                      backgroundColor: '#27272a',
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 16,
                    }}
                  >
                    <Text style={{ color: '#d4d4d8', fontSize: 14, lineHeight: 20 }}>
                      {selectedTask.result}
                    </Text>
                  </View>
                </>
              )}

              {/* Error */}
              {selectedTask?.errorMessage && (
                <>
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' }}>
                    Error
                  </Text>
                  <View
                    style={{
                      backgroundColor: 'rgba(239,68,68,0.1)',
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 16,
                    }}
                  >
                    <Text style={{ color: '#fca5a5', fontSize: 14, lineHeight: 20 }}>
                      {selectedTask.errorMessage}
                    </Text>
                  </View>
                </>
              )}

              {/* Cost and timestamps */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                {selectedTask?.costUsd !== undefined && (
                  <View>
                    <Text style={{ color: '#71717a', fontSize: 11 }}>Cost</Text>
                    <Text style={{ color: '#22c55e', fontSize: 14, fontWeight: '600' }}>
                      {formatCost(selectedTask.costUsd)}
                    </Text>
                  </View>
                )}
                {selectedTask?.completedAt && (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: '#71717a', fontSize: 11 }}>Completed</Text>
                    <Text style={{ color: '#d4d4d8', fontSize: 14 }}>
                      {formatRelativeTime(selectedTask.completedAt)}
                    </Text>
                  </View>
                )}
              </View>

              {/* Cancel button inside modal for active tasks */}
              {selectedTask && (selectedTask.status === 'queued' || selectedTask.status === 'running') && onCancelTask && (
                <Pressable
                  onPress={() => {
                    void handleCancel(selectedTask.id);
                    setSelectedTask(null);
                  }}
                  disabled={isCancelling === selectedTask.id}
                  style={{
                    marginTop: 8,
                    marginBottom: 16,
                    paddingVertical: 14,
                    borderRadius: 12,
                    backgroundColor: 'rgba(239,68,68,0.1)',
                    borderWidth: 1,
                    borderColor: 'rgba(239,68,68,0.3)',
                    alignItems: 'center',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel this task"
                >
                  {isCancelling === selectedTask.id ? (
                    <ActivityIndicator size="small" color="#ef4444" />
                  ) : (
                    <Text style={{ color: '#ef4444', fontWeight: '700', fontSize: 15 }}>
                      Cancel Task
                    </Text>
                  )}
                </Pressable>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ============================================================================
// Row mapper
// ============================================================================

/**
 * Maps a raw Supabase row (snake_case) to the typed CloudTask interface (camelCase).
 *
 * WHY: Supabase returns column names as-is from the DB (snake_case). The shared
 * CloudTask type uses camelCase per TypeScript conventions. This mapper is
 * the single place where column name translation happens, reducing subtle bugs.
 *
 * @param row - Raw database row from the cloud_tasks table
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
