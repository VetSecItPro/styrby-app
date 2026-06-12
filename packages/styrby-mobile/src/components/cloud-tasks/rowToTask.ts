/**
 * Supabase row → CloudTask mapper.
 *
 * Extracted from CloudTasks.tsx (Cluster A2 split). The single place where
 * snake_case DB columns are translated to the camelCase shared CloudTask type.
 *
 * @module components/cloud-tasks/rowToTask
 */

import type { CloudTask, CloudTaskStatus, AgentType } from 'styrby-shared';

/**
 * Maps a raw `cloud_tasks` row to the typed CloudTask interface.
 *
 * @param row - Raw database row (snake_case).
 * @returns Typed CloudTask (camelCase).
 */
export function rowToTask(row: Record<string, unknown>): CloudTask {
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
