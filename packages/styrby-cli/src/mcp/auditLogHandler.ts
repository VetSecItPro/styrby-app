/**
 * apiClient-backed audit-log handler for the MCP server.
 *
 * Implements the {@link AuditLogHandler} contract from `./server.ts` by writing
 * the agent's note to `POST /api/v1/audit` with the fixed `mcp_agent_log`
 * action (migration 102). The note + advisory level + any structured context
 * are carried in `metadata`; the action itself is non-authority-bearing so a
 * write-scoped key cannot abuse it to forge a privileged event.
 *
 * @module mcp/auditLogHandler
 */

import type { AuditLogHandler } from './server.js';
import type { LogToAuditInput, LogToAuditOutput } from './tools.js';
import type { StyrbyApiClient } from '@/api/styrbyApiClient';

/** The single allowlisted audit_action this tool may write (migration 102). */
const MCP_AGENT_LOG_ACTION = 'mcp_agent_log';

/**
 * Creates an apiClient-backed AuditLogHandler.
 *
 * @param apiClient - Authenticated StyrbyApiClient with the user's styrby_* key.
 * @returns A handler the MCP server uses to back the `log_to_audit` tool.
 */
export function createApiAuditLogHandler(apiClient: StyrbyApiClient): AuditLogHandler {
  return {
    async log(input: LogToAuditInput): Promise<LogToAuditOutput> {
      // The agent's note + advisory level + context all live in metadata. The
      // top-level `action` is the fixed informational identifier.
      const metadata: Record<string, unknown> = {
        message: input.message,
        level: input.level ?? 'info',
        ...(input.context ?? {}),
      };

      try {
        const res = await apiClient.writeAuditEvent({
          action: MCP_AGENT_LOG_ACTION,
          resource_type: input.resourceType,
          resource_id: input.resourceId,
          metadata,
        });
        return { id: res.id, recordedAt: res.created_at };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        throw new Error(`Failed to record audit event: ${msg}`);
      }
    },
  };
}
