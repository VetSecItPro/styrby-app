/**
 * MCP Tool Definitions for Styrby
 *
 * The Phase 1 wedge exposes a single tool — `request_approval` — that is
 * uniquely valuable to Styrby vs every other coding-agent bridge. Other
 * agents can call back into Styrby to request a human approval that is
 * delivered as a mobile push notification, with the approving user's
 * decision flowing back as the tool's return value.
 *
 * ## Tool catalog (Phase 1)
 *
 * | Tool name          | What it does                                              | Why Styrby? |
 * |--------------------|-----------------------------------------------------------|-------------|
 * | `request_approval` | Sends a push to the paired mobile device, awaits decision | Mobile-approval flow only Styrby has |
 *
 * Phase 4 will expand this to `get_team_policy`, `log_to_audit`,
 * `query_session_history`, and `propose_budget_change`.
 *
 * ## Why MCP at all?
 *
 * MCP (Model Context Protocol) lets agents request capabilities from the
 * surrounding environment in a standardized way. By exposing Styrby AS
 * an MCP server, agents like Claude Code, Codex, etc. can call back into
 * Styrby - not just receive output from it. That inverts the usual bridge
 * relationship and makes Styrby a platform agents depend on, rather than
 * a shell that wraps them.
 *
 * The Phase 1 wedge proves the model. Phase 4 builds the moat (full
 * client/server pair + registry browser + per-team tool policies).
 *
 * @module mcp/tools
 */

import { z } from 'zod';

// ============================================================================
// request_approval
// ============================================================================

/**
 * Risk level of an action that needs user approval.
 *
 * The mobile UI uses this to color-code the approval card and decide
 * whether biometric re-auth is required (HIGH triggers Face ID/Touch ID
 * prompt, MEDIUM/LOW use a simple tap).
 */
export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * Input schema for the `request_approval` tool.
 *
 * @property action - Short imperative summary ("Delete production database",
 *                    "Push to main branch", "Run npm publish")
 * @property reason - Why the agent wants to do this. Shown to the user.
 * @property risk - Risk level driving UI treatment (color, biometric)
 * @property timeoutSeconds - Optional. How long to wait for the user.
 *                            Defaults to 300 (5 minutes). Capped at 1800.
 * @property context - Optional structured context (file paths, command, diff).
 *                     Renders as expandable detail in the mobile UI.
 */
export const RequestApprovalInputSchema = {
  action: z.string().min(1).max(500),
  reason: z.string().min(1).max(2000),
  risk: RiskLevelSchema,
  timeoutSeconds: z.number().int().min(10).max(1800).optional(),
  context: z.record(z.unknown()).optional(),
};

/**
 * Output of the `request_approval` tool.
 *
 * @property decision - Either 'approved' (user tapped Approve) or 'denied'
 *                      (user tapped Deny or the request timed out).
 * @property decidedAt - ISO 8601 timestamp of when the user decided. For
 *                       timeouts, the timestamp the timeout fired.
 * @property reason - Optional message the user added when denying ("not now",
 *                    "wrong project"). Empty string when approved without comment.
 */
export const RequestApprovalOutputSchema = {
  decision: z.enum(['approved', 'denied']),
  decidedAt: z.string(),
  reason: z.string().optional(),
};

export type RequestApprovalInput = {
  action: string;
  reason: string;
  risk: RiskLevel;
  timeoutSeconds?: number;
  context?: Record<string, unknown>;
};

export type RequestApprovalOutput = {
  decision: 'approved' | 'denied';
  decidedAt: string;
  reason?: string;
};

// ============================================================================
// get_team_policy
// ============================================================================

/**
 * Input schema for the `get_team_policy` tool.
 *
 * The tool returns the calling user's active team governance policies so an
 * agent can self-check BEFORE acting (e.g. "is there a cost threshold or a
 * tool allowlist I should respect?"). Input is intentionally minimal — the
 * agent reasons over the returned rules rather than the server pre-filtering.
 *
 * @property agentType - Optional. The agent's own type (e.g. `claude`, `codex`).
 *                       Advisory only — included so future server-side filtering
 *                       can narrow to policies whose `agentFilter` matches.
 */
export const GetTeamPolicyInputSchema = {
  agentType: z.string().min(1).max(50).optional(),
};

/**
 * A single team governance policy as exposed to an agent.
 *
 * Mirrors the agent-relevant columns of the `team_policies` table
 * (migration 021). Internal columns (ids, approver_user_id, timestamps) are
 * deliberately omitted — an agent only needs to know WHAT the rule is and what
 * happens when it matches, not who authored it.
 *
 * @property name - Human-readable policy name.
 * @property description - Optional longer explanation.
 * @property ruleType - 'cost_threshold' | 'agent_filter' | 'tool_allowlist' | 'time_window'.
 * @property action - What happens on match: 'block' | 'require_approval' | 'allow_with_audit'.
 * @property threshold - Numeric threshold (e.g. USD for cost_threshold); null when N/A.
 * @property agentFilter - Agent types / tool names the rule applies to ([] = all).
 * @property priority - Lower = evaluated first.
 */
export const TeamPolicySchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  ruleType: z.enum(['cost_threshold', 'agent_filter', 'tool_allowlist', 'time_window']),
  action: z.enum(['block', 'require_approval', 'allow_with_audit']),
  threshold: z.number().nullable(),
  agentFilter: z.array(z.string()),
  priority: z.number(),
});
export type TeamPolicy = z.infer<typeof TeamPolicySchema>;

/**
 * Output of the `get_team_policy` tool.
 *
 * @property policies - Enabled governance policies for the user's team, ordered
 *                      by priority (ascending). Empty for solo users (no team).
 * @property hasTeam - False when the user belongs to no team (solo Free/Pro).
 *                     Lets the agent distinguish "no team" from "team with zero
 *                     policies" without inspecting array length semantics.
 */
export const GetTeamPolicyOutputSchema = {
  policies: z.array(TeamPolicySchema),
  hasTeam: z.boolean(),
};

export type GetTeamPolicyInput = {
  agentType?: string;
};

export type GetTeamPolicyOutput = {
  policies: TeamPolicy[];
  hasTeam: boolean;
};

// ============================================================================
// log_to_audit
// ============================================================================

/**
 * Advisory severity for an agent-logged audit event. Informational only — it
 * has no authority-bearing meaning; it just helps a human scanning the trail.
 */
export const AuditLogLevelSchema = z.enum(['info', 'warning', 'error']);
export type AuditLogLevel = z.infer<typeof AuditLogLevelSchema>;

/**
 * Input schema for the `log_to_audit` tool.
 *
 * Lets an agent record what it did to the user's audit trail (e.g. "ran
 * database migration 014", "deleted 3 stale branches"). Writes the fixed,
 * non-authority-bearing `mcp_agent_log` action; the note + context live in
 * metadata. This is the compliance leg of the orchestration wedge.
 *
 * @property message - Human-readable note describing what the agent did.
 * @property level - Optional advisory severity (default 'info').
 * @property resourceType - Optional entity type the event relates to (e.g. 'session').
 * @property resourceId - Optional entity id.
 * @property context - Optional structured detail (files touched, command, etc.).
 */
export const LogToAuditInputSchema = {
  message: z.string().min(1).max(2000),
  level: AuditLogLevelSchema.optional(),
  resourceType: z.string().min(1).max(100).optional(),
  resourceId: z.string().min(1).max(255).optional(),
  context: z.record(z.unknown()).optional(),
};

/**
 * Output of the `log_to_audit` tool.
 *
 * @property id - The audit_log row id created.
 * @property recordedAt - ISO 8601 timestamp the event was recorded.
 */
export const LogToAuditOutputSchema = {
  id: z.string(),
  recordedAt: z.string(),
};

export type LogToAuditInput = {
  message: string;
  level?: AuditLogLevel;
  resourceType?: string;
  resourceId?: string;
  context?: Record<string, unknown>;
};

export type LogToAuditOutput = {
  id: string;
  recordedAt: string;
};

// ============================================================================
// Tool catalog metadata
// ============================================================================

// The catalog itself lives in @styrby/shared so web + mobile registry UIs
// render the same list. Re-export here for CLI-local convenience.
export {
  STYRBY_MCP_TOOLS,
  type MCPToolDescriptor,
  type MCPToolCategory,
  type MCPToolStatus,
} from 'styrby-shared';
