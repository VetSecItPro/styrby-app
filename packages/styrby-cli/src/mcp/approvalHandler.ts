/**
 * Supabase-backed approval handler for the MCP server.
 *
 * Implements the {@link ApprovalHandler} contract from `./server.ts` by
 * inserting a pending approval row in Supabase, awaiting the user's
 * decision via Realtime, and returning the resolved decision to the MCP
 * tool caller.
 *
 * ## Storage shape
 *
 * Approvals live in the existing `audit_log` table for the Phase 1 wedge
 * (no schema migration needed — we record approval lifecycle as
 * `mcp.approval_requested` and `mcp.approval_decided` audit events).
 * Phase 4 will add a dedicated `mcp_approvals` table with FK to
 * `agent_configs` and proper status indexes.
 *
 * ## Wedge limitation
 *
 * Phase 1 short-circuits the realtime subscription with a poll loop
 * because:
 *   1. The mobile app's approval-decision UI ships in this PR but the
 *      mobile-to-backend write (DB UPDATE on the audit_log row) is the
 *      remaining piece — wired in a follow-up PR.
 *   2. Polling avoids the realtime channel-management overhead during
 *      the wedge demo.
 *
 * Phase 4 swaps this for a Supabase Realtime subscription on the
 * dedicated approvals table, eliminating the poll and dropping
 * mean-decision-time latency from ~1s to <100ms.
 *
 * @module mcp/approvalHandler
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApprovalHandler } from './server.js';
import type { RequestApprovalInput, RequestApprovalOutput } from './tools.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Polling interval for approval decisions.
 *
 * WHY 1 second: balances responsiveness for the human (1s feels instant
 * after biometric tap) against Supabase query volume during the wait.
 * Phase 4 realtime subscription removes polling entirely.
 */
const POLL_INTERVAL_MS = 1000;

/**
 * Audit-log event names.
 * Stable identifiers used for both writes and reads — changing these
 * breaks the poll loop's lookup, so they live as named constants.
 */
const AUDIT_EVENT_REQUESTED = 'mcp.approval_requested';
const AUDIT_EVENT_DECIDED = 'mcp.approval_decided';

// ============================================================================
// Approval row shape
// ============================================================================

/**
 * Metadata persisted in the audit_log.metadata JSONB column.
 * Keep keys snake_case to match the existing column convention.
 */
interface ApprovalMetadata {
  approval_id: string;
  action: string;
  reason: string;
  risk: string;
  context?: Record<string, unknown>;
}

/**
 * Decision metadata written by the mobile client.
 * The `approval_id` field is the join key.
 */
interface DecisionMetadata {
  approval_id: string;
  decision: 'approved' | 'denied';
  user_message?: string;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a Supabase-backed ApprovalHandler.
 *
 * The handler is bound to a single user + machine context so the audit
 * row can identify whose mobile device should receive the push.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The Styrby user ID to push to
 * @param machineId - The CLI machine the agent is running on
 * @returns An ApprovalHandler ready to be passed to createStyrbyMcpServer
 */
export function createSupabaseApprovalHandler(
  supabase: SupabaseClient,
  userId: string,
  machineId: string,
): ApprovalHandler {
  return {
    async request(
      input: RequestApprovalInput,
      timeoutMs: number,
    ): Promise<RequestApprovalOutput> {
      const approvalId = randomUUID();

      // 1. Insert the request audit row. The push trigger configured in
      //    migration 017 fires on inserts to audit_log with the
      //    'mcp.approval_requested' event_type and delivers a push to the
      //    user's device tokens.
      const requestMetadata: ApprovalMetadata = {
        approval_id: approvalId,
        action: input.action,
        reason: input.reason,
        risk: input.risk,
        context: input.context,
      };

      const { error: insertError } = await supabase.from('audit_log').insert({
        user_id: userId,
        machine_id: machineId,
        event_type: AUDIT_EVENT_REQUESTED,
        severity: input.risk === 'high' ? 'warning' : 'info',
        metadata: requestMetadata,
      });

      if (insertError) {
        throw new Error(`Failed to record approval request: ${insertError.message}`);
      }

      // 2. Poll for the decision row.
      // WHY poll instead of realtime: see module comment. Phase 4 swaps
      // this for a `supabase.channel(...).on('postgres_changes', ...)`
      // subscription on the dedicated mcp_approvals table.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { data, error } = await supabase
          .from('audit_log')
          .select('metadata, created_at')
          .eq('user_id', userId)
          .eq('event_type', AUDIT_EVENT_DECIDED)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) {
          throw new Error(`Failed to poll for decision: ${error.message}`);
        }

        const matched = (data ?? []).find((row) => {
          const meta = row.metadata as DecisionMetadata | null;
          return meta?.approval_id === approvalId;
        });

        if (matched) {
          const meta = matched.metadata as DecisionMetadata;
          return {
            decision: meta.decision,
            decidedAt: matched.created_at as string,
            reason: meta.user_message ?? '',
          };
        }

        await sleep(POLL_INTERVAL_MS);
      }

      // 3. Timeout — record the timeout as a denial in the audit log so
      //    the trail is complete, then return denied to the agent.
      const timeoutAt = new Date().toISOString();
      const timeoutMetadata: DecisionMetadata = {
        approval_id: approvalId,
        decision: 'denied',
        user_message: 'No response — request timed out',
      };
      await supabase.from('audit_log').insert({
        user_id: userId,
        machine_id: machineId,
        event_type: AUDIT_EVENT_DECIDED,
        severity: 'info',
        metadata: timeoutMetadata,
      });

      return {
        decision: 'denied',
        decidedAt: timeoutAt,
        reason: 'No response — request timed out',
      };
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Promise-based sleep. Avoids importing setTimeout from node:timers/promises
 * to keep the file tree-shakeable for the Edge runtime in Phase 4.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
