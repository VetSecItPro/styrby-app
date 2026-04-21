/**
 * Styrby MCP Server
 *
 * Exposes Styrby AS an MCP (Model Context Protocol) server so that
 * MCP-aware coding agents (Claude Code, Codex, Cursor, etc.) can call
 * back into Styrby for capabilities only Styrby has — most importantly,
 * the mobile-approval flow.
 *
 * ## Architecture
 *
 * ```
 *   ┌──────────────┐    MCP/stdio     ┌─────────────────┐    HTTP    ┌─────────────────┐
 *   │ Coding agent │ ───────────────► │ Styrby MCP srv  │ ─────────► │ Supabase / push │
 *   │ (Claude etc) │                  │ (this file)     │            │ delivery        │
 *   └──────────────┘                  └─────────────────┘            └─────────────────┘
 *                                            │                              │
 *                                            ▼                              ▼
 *                                     tool handlers                   mobile device
 *                                                                     (approval card)
 * ```
 *
 * The agent invokes a tool (e.g. `request_approval`). The handler talks
 * to Supabase to insert a pending approval row, which triggers a push
 * notification to the user's mobile device. The handler awaits the
 * user's decision (DB poll or realtime subscription) and returns the
 * decision as the tool's result.
 *
 * ## Transport
 *
 * Phase 1 supports stdio transport only (the default for local MCP
 * servers spawned by an agent process). HTTP/SSE transport for remote
 * agents lands in Phase 4.
 *
 * ## Why a separate process
 *
 * The MCP server runs as a sibling process to the styrby-cli daemon.
 * Putting them in one process would entangle the agent stdio (parsed
 * by the SDK) with our own logging — confusing both. Phase 4 may
 * collapse them when we have a proper IPC layer.
 *
 * @module mcp/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RequestApprovalInputSchema,
  RequestApprovalOutputSchema,
  type RequestApprovalInput,
  type RequestApprovalOutput,
} from './tools.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Server identity reported in the MCP `initialize` handshake.
 * Bumps with breaking tool-schema changes only — adding new tools or
 * extending optional fields keeps the same version.
 */
const SERVER_INFO = {
  name: 'styrby-mcp-server',
  version: '0.2.0-wedge',
} as const;

/**
 * Default approval timeout (5 minutes). Matches WebAuthn challenge TTL
 * and the existing push-notification round-trip budget. Caller can
 * override per-request up to 30 minutes.
 */
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

// ============================================================================
// Approval handler injection
// ============================================================================

/**
 * The approval handler is the dependency that actually talks to Supabase
 * + push delivery. It's injected (rather than imported directly) so:
 *   1. Tests can stub it without touching the network
 *   2. Future Phase 4 work can swap implementations (e.g. local-only
 *      "auto-approve everything" mode for development)
 *
 * The default real implementation lives in `./approvalHandler.ts` and
 * is wired in `commands/mcpServe.ts`.
 */
export interface ApprovalHandler {
  /**
   * Submits an approval request and resolves with the user's decision.
   *
   * @param input - Validated tool input (action, reason, risk, etc.)
   * @param timeoutMs - Hard deadline in milliseconds
   * @returns The user's decision once they tap or the timeout fires
   * @throws {Error} On Supabase failures — the MCP layer converts this to a tool error response
   */
  request(input: RequestApprovalInput, timeoutMs: number): Promise<RequestApprovalOutput>;
}

// ============================================================================
// Server factory
// ============================================================================

/**
 * Builds a fresh `McpServer` with all Styrby tools registered.
 *
 * Returns an unconnected server. Caller must invoke `server.connect(transport)`
 * to start serving. Splitting construction from transport binding lets tests
 * exercise the tool handlers directly without a transport.
 *
 * @param approvalHandler - The dependency that delivers approval requests to mobile
 * @returns The configured McpServer instance
 *
 * @example
 * ```ts
 * const handler = await createSupabaseApprovalHandler(supabase);
 * const server = createStyrbyMcpServer(handler);
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createStyrbyMcpServer(approvalHandler: ApprovalHandler): McpServer {
  const server = new McpServer(SERVER_INFO);

  // ── request_approval tool ────────────────────────────────────────────────
  server.registerTool(
    'request_approval',
    {
      title: 'Request human approval',
      description:
        'Send the paired mobile device a push notification requesting approval for an action. Resolves when the user taps Approve/Deny or the timeout elapses. Use this before destructive or high-risk operations.',
      inputSchema: RequestApprovalInputSchema,
      outputSchema: RequestApprovalOutputSchema,
      annotations: {
        // WHY readOnlyHint=false: the tool itself doesn't mutate user data,
        // but the agent's caller is asking permission to perform a mutation.
        // Marking it non-read-only signals to MCP clients that this is a
        // privileged path that should not be auto-approved by client-side
        // policies.
        readOnlyHint: false,
        // WHY destructiveHint follows the risk: high-risk approvals are
        // requested for actions that will likely modify or delete state.
        // Clients use this as one input to their own UI prompts.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: RequestApprovalOutput }> => {
      const timeoutMs = (input.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS) * 1000;
      const result = await approvalHandler.request(input as RequestApprovalInput, timeoutMs);

      return {
        // WHY both content and structuredContent: MCP requires `content`
        // for backward compatibility with clients that don't read structured
        // output. structuredContent gives modern clients the typed payload.
        content: [
          {
            type: 'text',
            text: `Decision: ${result.decision}${result.reason ? ` — ${result.reason}` : ''} (at ${result.decidedAt})`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  return server;
}

// ============================================================================
// Convenience runner
// ============================================================================

/**
 * Spawns the server bound to stdio transport. Used by `styrby mcp serve`.
 *
 * Resolves once the transport closes (which is the normal "agent quit"
 * shutdown signal — we never want the server outliving its consumer).
 *
 * @param approvalHandler - Real or test approval handler
 */
export async function runStdioServer(approvalHandler: ApprovalHandler): Promise<void> {
  const server = createStyrbyMcpServer(approvalHandler);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps process.stdin alive; resolution happens when the
  // parent agent closes our stdin, which the SDK surfaces as transport close.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
