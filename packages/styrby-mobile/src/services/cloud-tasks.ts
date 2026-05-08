/**
 * Cloud Tasks Service
 *
 * Mobile-side helpers for the cloud_tasks Supabase table — the backing store
 * for the Power-tier "Cloud Monitoring" and "Code Review From Mobile"
 * features.
 *
 * What lives here:
 * - cancelCloudTask: matches the `styrby cloud cancel` CLI command's
 *   semantics (pre-flight status check + UPDATE to 'cancelled')
 *
 * The CloudTasks UI component (`src/components/CloudTasks.tsx`) handles its
 * own SELECT and Realtime subscription — those are display concerns. This
 * module owns mutation operations the screen wires into the component's
 * onCancelTask prop.
 *
 * @see packages/styrby-cli/src/commands/cloud.ts for the CLI counterpart
 * @see supabase/migrations/063_cloud_tasks.sql for the schema
 */

import { supabase } from '../lib/supabase';
import type { CloudTaskStatus } from 'styrby-shared';

/**
 * Statuses from which a cloud task may be cancelled.
 *
 * WHY: Mirrors the CLI's whitelist (`packages/styrby-cli/src/commands/cloud.ts:484`)
 * so the mobile cancel flow has identical semantics. Completed/failed/already-
 * cancelled tasks should never present a Cancel button in the UI, but this
 * server-side check is the authoritative gate.
 */
export const CANCELLABLE_STATUSES: readonly CloudTaskStatus[] = ['queued', 'running'];

/**
 * Updates a cloud task's status to 'cancelled' after verifying the task is
 * in a cancellable state. Mirrors `styrby cloud cancel <taskId>`.
 *
 * Pre-flight SELECT (matching cli/cloud.ts:471):
 * Without it, an UPDATE on a 'completed'/'failed'/'cancelled' task succeeds
 * silently (RLS allows it) and we'd give the user false confidence that an
 * already-finished task was cancelled.
 *
 * Cancellation propagation:
 * The relay infrastructure subscribes to cloud_tasks and terminates the
 * agent execution when status flips to 'cancelled' (per migration 063
 * comment + CLI cancel command).
 *
 * @param taskId - UUID of the task to cancel
 * @throws {Error} If the task is not found, not owned by the caller (RLS),
 *                 already in a non-cancellable terminal state, or if the
 *                 Supabase request itself fails
 *
 * @example
 * try {
 *   await cancelCloudTask(task.id);
 * } catch (e) {
 *   Alert.alert('Could not cancel', e instanceof Error ? e.message : 'Unknown error');
 * }
 */
export async function cancelCloudTask(taskId: string): Promise<void> {
  const { data: task, error: fetchError } = await supabase
    .from('cloud_tasks')
    .select('status')
    .eq('id', taskId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const currentStatus = task.status as CloudTaskStatus;
  if (!CANCELLABLE_STATUSES.includes(currentStatus)) {
    throw new Error(
      `Cannot cancel task with status "${currentStatus}". ` +
      `Only queued or running tasks can be cancelled.`
    );
  }

  const { error: updateError } = await supabase
    .from('cloud_tasks')
    .update({ status: 'cancelled' as CloudTaskStatus })
    .eq('id', taskId);

  if (updateError) throw new Error(updateError.message);
}
