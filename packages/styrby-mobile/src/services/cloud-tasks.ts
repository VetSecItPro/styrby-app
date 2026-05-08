/**
 * Cloud Tasks Service
 *
 * Mobile-side helpers for the cloud_tasks Supabase table — the backing store
 * for the Power-tier "Cloud Monitoring" feature.
 *
 * What lives here:
 * - submitCloudTask: dispatches a new agent task from the phone. Mirrors the
 *   CLI's `styrby cloud submit` semantics so a task created via mobile lands
 *   in the same queue, with the same shape, that the relay infrastructure
 *   already knows how to pick up and run.
 * - cancelCloudTask: matches the `styrby cloud cancel` CLI command's
 *   semantics (pre-flight status check + UPDATE to 'cancelled')
 *
 * The CloudTasks UI component (`src/components/CloudTasks.tsx`) handles its
 * own SELECT and Realtime subscription — those are display concerns. This
 * module owns mutation operations the screen and submit sheet wire in.
 *
 * @see packages/styrby-cli/src/commands/cloud.ts for the CLI counterpart
 * @see supabase/migrations/063_cloud_tasks.sql for the schema
 */

import { supabase } from '../lib/supabase';
import type { AgentType, CloudTask, CloudTaskStatus } from 'styrby-shared';

/**
 * Agents accepted by the cloud_tasks `agent_type` CHECK constraint
 * (migration 063 §2). Mirrored from the CLI's whitelist
 * (`packages/styrby-cli/src/commands/cloud.ts:265`) so the mobile picker
 * surfaces exactly the agents the backend will accept.
 */
export const SUBMITTABLE_AGENTS: readonly AgentType[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
];

/**
 * Maps a raw Supabase cloud_tasks row to the typed CloudTask interface.
 * Mirrors the rowToTask helper in `src/components/CloudTasks.tsx` so the
 * service can return typed data without forcing callers to translate.
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
 * Input shape for submitCloudTask.
 */
export interface SubmitCloudTaskInput {
  /** Required prompt text. Must be non-empty after trim. */
  prompt: string;

  /** Required agent. Must be one of SUBMITTABLE_AGENTS. */
  agentType: AgentType;

  /**
   * Optional FK to a session — links the cloud task to its originating
   * session for the "tasks spawned from this session" view. Pass null for
   * standalone tasks the user started without picking a session context.
   */
  sessionId?: string | null;

  /**
   * Optional display metadata. The CLI populates these when submitting from
   * inside a git repo; the mobile dispatcher can populate them by linking
   * the task to a recent session and copying its projectPath / gitBranch.
   */
  metadata?: {
    projectPath?: string;
    gitBranch?: string;
    model?: string;
  };

  /**
   * Optional duration estimate (milliseconds) — drives the progress bar in
   * the monitoring UI. Mobile usually leaves this null and lets the agent
   * fill it in when execution starts.
   */
  estimatedDurationMs?: number | null;
}

/**
 * Dispatches a new cloud agent task from the mobile app.
 *
 * Mirrors the CLI's submitCloudTask (`packages/styrby-cli/src/commands/cloud.ts:210`)
 * so a task submitted from mobile is indistinguishable from one submitted
 * via `styrby cloud submit`. The relay infrastructure picks both up the
 * same way.
 *
 * Validates input client-side and trusts RLS server-side:
 * - prompt: must be non-empty after trim (CLI does the same at line 259)
 * - agentType: must be in SUBMITTABLE_AGENTS (CLI: cloud.ts:265)
 * - user_id: pulled from the authenticated session — RLS prevents
 *   spoofing even if a malicious caller passed a different user_id
 *
 * @param input - SubmitCloudTaskInput
 * @returns The newly-inserted CloudTask, ready for optimistic UI insertion
 *          (Realtime will deliver the same row shortly after, which the list
 *          dedupes by id).
 * @throws {Error} On auth failure, validation failure, or Supabase write error
 *
 * @example
 * const task = await submitCloudTask({
 *   prompt: 'Run the test suite and summarize failures',
 *   agentType: 'claude',
 *   sessionId: lastSession.id,
 *   metadata: { projectPath: lastSession.project_path, gitBranch: lastSession.git_branch },
 * });
 * // task is queued, the relay will run it; mobile sees status updates via Realtime
 */
export async function submitCloudTask(input: SubmitCloudTaskInput): Promise<CloudTask> {
  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('Prompt is required');
  }
  if (!SUBMITTABLE_AGENTS.includes(input.agentType)) {
    throw new Error(
      `Invalid agent "${input.agentType}". Must be one of: ${SUBMITTABLE_AGENTS.join(', ')}`
    );
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('cloud_tasks')
    .insert({
      user_id: user.id,
      session_id: input.sessionId ?? null,
      agent_type: input.agentType,
      status: 'queued' as CloudTaskStatus,
      prompt: trimmedPrompt,
      metadata: input.metadata ?? null,
      estimated_duration_ms: input.estimatedDurationMs ?? null,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Insert succeeded but no row returned');

  return rowToTask(data as Record<string, unknown>);
}

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
