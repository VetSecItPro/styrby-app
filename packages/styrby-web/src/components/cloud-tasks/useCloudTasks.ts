/**
 * useCloudTasks — data load + realtime subscription + cancel for the web panel.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split). Loads the user's 20 most
 * recent tasks, subscribes to Supabase Realtime scoped to that user, and
 * exposes the optimistic cancel flow. The component consumes the state and
 * only renders.
 *
 * @module components/cloud-tasks/useCloudTasks
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { CloudTask, CloudTaskStatus } from '@styrby/shared';
import { rowToTask } from './rowToTask';

/** State + handlers the CloudTasksPanel renders with. */
export interface UseCloudTasks {
  tasks: CloudTask[];
  isLoading: boolean;
  cancellingId: string | null;
  handleCancel: (taskId: string) => Promise<void>;
}

/**
 * Load + subscribe to + cancel the user's cloud tasks.
 *
 * @param userId - Authenticated user id (scopes the query + realtime channel).
 * @returns Task list state + the cancel handler.
 */
export function useCloudTasks(userId: string): UseCloudTasks {
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  // --- Load + Real-time -----------------------------------------------------

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
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'cloud_tasks', filter: `user_id=eq.${userId}` },
        (payload: any) => {
          if (!isMounted) return;

          if (payload.eventType === 'INSERT') {
            setTasks((prev) => [rowToTask(payload.new), ...prev].slice(0, 20));
          } else if (payload.eventType === 'UPDATE') {
            setTasks((prev) =>
              prev.map((t) => (t.id === payload.new.id ? rowToTask(payload.new) : t)),
            );
          } else if (payload.eventType === 'DELETE') {
            setTasks((prev) => prev.filter((t) => t.id !== payload.old.id));
          }
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      void supabase.removeChannel(channel);
    };
  }, [userId, supabase]);

  // --- Cancel ---------------------------------------------------------------

  /**
   * Cancel a cloud task by updating its status in Supabase.
   * Uses an optimistic update for immediate UI feedback.
   *
   * @param taskId - The task UUID to cancel.
   */
  const handleCancel = useCallback(
    async (taskId: string) => {
      setCancellingId(taskId);

      // Optimistic update.
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'cancelled' as CloudTaskStatus } : t)),
      );

      const { error } = await supabase
        .from('cloud_tasks')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', taskId);

      if (error) {
        // Revert is unnecessary - Realtime will correct eventually.
        console.error('[CloudTasks] Cancel failed:', error.message);
      }

      setCancellingId(null);
    },
    [supabase],
  );

  return { tasks, isLoading, cancellingId, handleCancel };
}
