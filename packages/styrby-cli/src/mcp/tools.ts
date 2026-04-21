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
// Tool catalog metadata
// ============================================================================

/**
 * Public catalog of tools exposed by Styrby's MCP server.
 *
 * The web's /dashboard/tools page and mobile's settings/tools.tsx both
 * render this list to show users what their MCP-aware agents can call.
 * Keep entries human-readable - end users see them, not just developers.
 */
export interface MCPToolDescriptor {
  /** Stable tool name used by MCP clients (snake_case per MCP spec). */
  name: string;
  /** Human-readable title shown in registry UIs. */
  title: string;
  /** One-paragraph description shown when expanded. */
  description: string;
  /** Risk class affecting UI surfacing. */
  category: 'approval' | 'policy' | 'audit' | 'query' | 'mutation';
  /** Whether the tool is GA in this release or still experimental. */
  status: 'ga' | 'beta' | 'planned';
  /** Loose semver of when introduced. */
  introducedIn: string;
}

export const STYRBY_MCP_TOOLS: readonly MCPToolDescriptor[] = [
  {
    name: 'request_approval',
    title: 'Request human approval',
    description:
      'Sends a push notification to the paired mobile device asking the user to approve or deny a high-risk action. Returns when the user decides or the timeout fires. Lets agents safely run destructive operations under explicit human oversight.',
    category: 'approval',
    status: 'ga',
    introducedIn: '0.2.0',
  },
  {
    name: 'get_team_policy',
    title: 'Look up team policy',
    description:
      'Returns the effective approval/budget/blocked-tool policy for the agent\'s session. Lets agents check before attempting an action whether it would auto-block or require approval. Phase 4.',
    category: 'policy',
    status: 'planned',
    introducedIn: '0.4.0',
  },
  {
    name: 'log_to_audit',
    title: 'Write to audit log',
    description:
      'Appends a structured event to the user\'s audit log table. Useful for compliance trails (SOC2 CC7.2) when agents take significant actions. Phase 4.',
    category: 'audit',
    status: 'planned',
    introducedIn: '0.4.0',
  },
] as const;
