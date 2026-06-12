/**
 * useCloudTasks — data + realtime + progress-tick + cancel for the cloud task list.
 *
 * Extracted from CloudTasks.tsx (Cluster A2 split). Loads the user's recent
 * tasks, subscribes to Supabase Realtime for live status updates, runs a
 * 1-second tick so running progress bars advance, and exposes the cancel flow.
 * The component consumes the returned state and only renders.
 *
 * @module components/cloud-tasks/useCloudTasks
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import type { CloudTask, CloudTaskStatus } from 'styrby-shared';
import { rowToTask } from './rowToTask';

/** State + handlers the CloudTasks component needs to render. */
export interface UseCloudTasks {
  tasks: CloudTask[];
  isLoading: boolean;
  isRefreshing: boolean;
  selectedTask: CloudTask | null;
  setSelectedTask: (task: CloudTask | null) => void;
  isCancelling: string | null;
  handleRefresh: () => void;
  handleCancel: (taskId: string) => Promise<void>;
}

/**
 * @param userId - Authenticated user id (scopes the query + realtime channel).
 * @param onCancelTask - Optional cancel callback supplied by the parent.
 * @returns Task list state + handlers.
 */
export function useCloudTasks(
  userId: string,
  onCancelTask?: (taskId: string) => Promise<void>,
): UseCloudTasks {
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedTask, setSelectedTask] = useState<CloudTask | null>(null);
  const [isCancelling, setIsCancelling] = useState<string | null>(null);

  // Track a tick so running tasks' progress bars update every second.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, setTick] = useState(0);

  // --- Data loading ---------------------------------------------------------

  const loadTasks = useCallback(
    async (silent = false) => {
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
    },
    [userId],
  );

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void loadTasks(true);
  }, [loadTasks]);

  // --- Realtime subscription ------------------------------------------------

  useEffect(() => {
    void loadTasks();

    // Subscribe only to this user's cloud_tasks (defense in depth beyond RLS).
    const channel = supabase
      .channel(`cloud_tasks:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'cloud_tasks', filter: `user_id=eq.${userId}` },
        (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
          if (payload.eventType === 'INSERT') {
            setTasks((prev) => [rowToTask(payload.new), ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTasks((prev) =>
              prev.map((t) => (t.id === (payload.new as { id: string }).id ? rowToTask(payload.new) : t)),
            );
            // If the detail modal is open for this task, update it too.
            setSelectedTask((prev) =>
              prev && prev.id === (payload.new as { id: string }).id ? rowToTask(payload.new) : prev,
            );
          } else if (payload.eventType === 'DELETE') {
            setTasks((prev) => prev.filter((t) => t.id !== (payload.old as { id: string }).id));
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, loadTasks]);

  // --- Progress-bar tick ----------------------------------------------------

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

  // --- Cancel ---------------------------------------------------------------

  const handleCancel = useCallback(
    async (taskId: string) => {
      if (!onCancelTask) return;
      setIsCancelling(taskId);
      try {
        await onCancelTask(taskId);
        // Optimistic update — the realtime event may arrive seconds later.
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, status: 'cancelled' as CloudTaskStatus } : t)),
        );
      } catch {
        // Realtime will correct state if the cancel fails.
      } finally {
        setIsCancelling(null);
      }
    },
    [onCancelTask],
  );

  return {
    tasks,
    isLoading,
    isRefreshing,
    selectedTask,
    setSelectedTask,
    isCancelling,
    handleRefresh,
    handleCancel,
  };
}
