/**
 * MCP Approval Decision Writer
 *
 * Writes the user's approve/deny decision to the audit_log table so the CLI's
 * `styrby mcp serve` polling loop (packages/styrby-cli/src/mcp/approvalHandler.ts)
 * can pick it up and unblock the MCP tool call.
 *
 * ## Contract
 *
 * The CLI polls audit_log with:
 *
 * ```ts
 * apiClient.searchAuditLog({
 *   action: 'mcp_approval_decided',
 *   resource_id: approvalId,
 *   limit: 1,
 * })
 * ```
 *
 * It then reads `metadata.decision` and `metadata.user_message`. Mismatch
 * any field name and the loop blocks until timeout. Every literal in this
 * module is load-bearing — do not rename without updating the CLI in lockstep.
 *
 * ## Security
 *
 * RLS enforces `user_id = auth.uid()` at the database layer (migration 070).
 * The mobile client cannot write decisions for another user even if compromised.
 * The policy is also scoped to `action='mcp_approval_decided'` so a hostile
 * client cannot forge other audit event types.
 *
 * @module services/mcp-approval
 */

import { supabase } from '@/lib/supabase';

// ============================================================================
// Constants — must match packages/styrby-cli/src/mcp/approvalHandler.ts
// ============================================================================

/**
 * Audit action enum value the CLI poll loop filters on.
 *
 * WHY constant: see module header — every literal here is part of the
 * cross-package contract. A typo silently breaks the entire MCP approval flow.
 */
const AUDIT_ACTION_DECIDED = 'mcp_approval_decided';

/**
 * Resource type the CLI poll loop filters on (combined with `resource_id`).
 *
 * WHY constant: same as above. Migration 069 added the audit_action enum
 * value and the CLI writes this exact resource_type when posting the request
 * row. Mobile must echo it on the decision row.
 */
const RESOURCE_TYPE = 'mcp_approval';

/**
 * Maximum length for the optional `user_message` field.
 *
 * WHY 280: matches the screen's TextInput limit. Enforced both client-side
 * (UX) and inside this writer (defence-in-depth) so a programmatic caller
 * cannot bypass the cap.
 */
const MAX_USER_MESSAGE_LENGTH = 280;

// ============================================================================
// Types
// ============================================================================

/**
 * Inputs for {@link writeMcpApprovalDecision}.
 *
 * Field naming intentionally matches the CLI side's `DecisionMetadata` shape
 * (snake_case in JSONB, camelCase at the TS function boundary).
 */
export interface WriteMcpApprovalDecisionInput {
  /** UUID of the approval row. Must match the CLI's `resource_id`. */
  approvalId: string;
  /** The user's binary decision. */
  decision: 'approved' | 'denied';
  /**
   * Optional human-readable note (e.g. "Looks safe, ship it").
   * Truncated to 280 chars before write.
   */
  userMessage?: string;
}

/**
 * Decision metadata persisted in audit_log.metadata JSONB.
 *
 * WHY mirror of {@link import('../../../styrby-cli/src/mcp/approvalHandler').DecisionMetadata}:
 * the CLI's polling loop reads exactly these snake_case keys. Drifting from
 * this shape silently breaks the contract; treat any rename as a coordinated
 * cross-package change.
 */
interface DecisionMetadata {
  approval_id: string;
  decision: 'approved' | 'denied';
  user_message?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Writes the user's MCP approval decision to audit_log.
 *
 * Resolves once the row is committed. The CLI's polling loop (1s cadence)
 * will pick it up on its next cycle and unblock the awaiting tool call.
 *
 * @param input - Approval ID + decision + optional user note.
 * @throws Error if the user is not authenticated or the INSERT fails (e.g.
 *   RLS rejection, network outage). Callers should surface this to the UI.
 *
 * @example
 * await writeMcpApprovalDecision({
 *   approvalId: 'a1b2c3d4-...',
 *   decision: 'approved',
 *   userMessage: 'Looks safe',
 * });
 */
export async function writeMcpApprovalDecision(
  input: WriteMcpApprovalDecisionInput,
): Promise<void> {
  const { approvalId, decision, userMessage } = input;

  // Defence-in-depth: enforce the cap server-bound even if the UI passes more.
  const trimmedMessage =
    typeof userMessage === 'string' && userMessage.length > 0
      ? userMessage.slice(0, MAX_USER_MESSAGE_LENGTH)
      : undefined;

  // WHY getUser() not getSession(): getUser() round-trips to Supabase Auth and
  // confirms the JWT is still valid. For a write that the CLI is actively
  // waiting on, an expired session must surface immediately rather than
  // silently failing the INSERT with an obscure RLS error.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw new Error(`Auth check failed: ${userError.message}`);
  }
  if (!user) {
    throw new Error('No authenticated user — cannot write approval decision');
  }

  const metadata: DecisionMetadata = {
    approval_id: approvalId,
    decision,
    ...(trimmedMessage !== undefined ? { user_message: trimmedMessage } : {}),
  };

  const { error: insertError } = await supabase.from('audit_log').insert({
    user_id: user.id,
    action: AUDIT_ACTION_DECIDED,
    resource_type: RESOURCE_TYPE,
    resource_id: approvalId,
    metadata,
  });

  if (insertError) {
    // WHY include code: RLS rejections come back as 42501 / "new row violates
    // row-level security policy". Surfacing the code helps on-call diagnose
    // a missing migration vs. a genuine auth failure vs. a network blip.
    const code = insertError.code ? ` [${insertError.code}]` : '';
    throw new Error(
      `Failed to write approval decision${code}: ${insertError.message}`,
    );
  }
}
