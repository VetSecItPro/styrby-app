/**
 * Shared MCP tool catalog.
 *
 * The single source of truth for what MCP tools Styrby exposes (and plans
 * to expose). Read by:
 *   - styrby-cli: server registration (`request_approval` is GA in 0.2.0)
 *   - styrby-web: /dashboard/tools registry browser
 *   - styrby-mobile: settings/tools.tsx mirror
 *
 * Keeping this list shared (vs duplicating across packages) ensures the
 * UI and the runtime never drift — every UI label maps to a real
 * server-side tool registration, and every planned-tool entry doubles as
 * the public roadmap.
 *
 * @module mcp/catalog
 */

/**
 * Functional category for the tool. Drives icon + color in registry UIs.
 */
export type MCPToolCategory = 'approval' | 'policy' | 'audit' | 'query' | 'mutation';

/**
 * Lifecycle status. `ga` tools are runnable today; `beta` are runnable but
 * may break; `planned` are roadmap items not yet implemented.
 */
export type MCPToolStatus = 'ga' | 'beta' | 'planned';

/**
 * Public descriptor for a Styrby MCP tool.
 */
export interface MCPToolDescriptor {
  /** Stable tool name used by MCP clients (snake_case per MCP spec). */
  name: string;
  /** Human-readable title shown in registry UIs. */
  title: string;
  /** One-paragraph description shown when expanded. */
  description: string;
  /** Risk class affecting UI surfacing. */
  category: MCPToolCategory;
  /** Whether the tool is GA in this release or still experimental. */
  status: MCPToolStatus;
  /** Loose semver of when introduced (or planned for). */
  introducedIn: string;
}

/**
 * The canonical list of Styrby MCP tools.
 *
 * WHY readonly: the array is consumed by both runtime (server registration)
 * and UI (display). Mutating it at runtime would create a drift window
 * between server reality and UI claims.
 */
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
  {
    name: 'query_session_history',
    title: 'Query past session messages',
    description:
      'Returns recent messages from the user\'s past sessions, filterable by agent, project path, and date. Lets agents continue prior work without manual context paste. Phase 4.',
    category: 'query',
    status: 'planned',
    introducedIn: '0.4.0',
  },
] as const;
