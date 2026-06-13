/**
 * MCP connection-readiness computation.
 *
 * The `/dashboard/tools` page shows a generic `styrby mcp serve` snippet, but
 * the MCP server has real prerequisites: `styrby mcp serve` refuses to start
 * unless the user has onboarded AND registered a machine, and its tools call
 * back into Styrby as the user. A user who wires the snippet without those
 * prerequisites gets silently-failing tools and no explanation.
 *
 * This module turns the user's account state (machines, push devices, team
 * membership) into an explicit, per-prerequisite readiness checklist with the
 * exact command to fix each gap. Pure + tested so the logic can't drift.
 *
 * @module app/dashboard/tools/mcp-readiness
 */

/** Account-state inputs that determine MCP readiness. */
export interface McpReadinessInput {
  /** Number of machines registered to the user (the `styrby pair` signal). */
  machineCount: number;
  /** Whether at least one registered machine is currently online. */
  hasOnlineMachine: boolean;
  /** Number of active push devices (the mobile app, for approval delivery). */
  deviceTokenCount: number;
  /** Whether the user belongs to a team (gates `get_team_policy`). */
  hasTeam: boolean;
}

/**
 * Per-check status.
 * - `ready`         — prerequisite satisfied.
 * - `action-needed` — hard requirement missing; the MCP server won't work.
 * - `recommended`   — soft gap; core works but a capability is degraded.
 * - `optional`      — not applicable to this user's plan (informational).
 */
export type McpCheckStatus = 'ready' | 'action-needed' | 'recommended' | 'optional';

/** A single readiness check tied to an MCP capability. */
export interface McpCheck {
  /** Stable identifier. */
  id: 'cli' | 'approvals' | 'team-policy';
  /** Short human label. */
  label: string;
  /** Current status. */
  status: McpCheckStatus;
  /** Plain-language description of the current state. */
  detail: string;
  /** The MCP tool(s) this prerequisite gates. */
  gates: string;
  /** CLI command or action to resolve a gap (omitted when `ready`/`optional`). */
  fix?: string;
}

/** Overall readiness plus the per-check breakdown. */
export interface McpReadiness {
  /**
   * `ready` once the hard requirement (a registered machine) is met — the MCP
   * server can start and serve tools. `not-connected` otherwise.
   */
  overall: 'ready' | 'not-connected';
  checks: McpCheck[];
}

/**
 * Compute the user's MCP connection readiness.
 *
 * WHY the machine check is the only hard gate: `styrby mcp serve` exits early
 * unless a machine is registered (see CLI commands/mcpServe.ts). The approval
 * device and team membership only degrade specific tools, so they are surfaced
 * as recommended/optional rather than blocking.
 *
 * @param input - The user's account state.
 * @returns Overall readiness + per-prerequisite checks.
 */
export function computeMcpReadiness(input: McpReadinessInput): McpReadiness {
  const { machineCount, hasOnlineMachine, deviceTokenCount, hasTeam } = input;

  const cli: McpCheck =
    machineCount > 0
      ? {
          id: 'cli',
          label: 'CLI connected',
          status: 'ready',
          detail: hasOnlineMachine
            ? `${machineCount} machine${machineCount === 1 ? '' : 's'} registered (at least one online).`
            : `${machineCount} machine${machineCount === 1 ? '' : 's'} registered (none currently online).`,
          gates: 'all tools',
        }
      : {
          id: 'cli',
          label: 'CLI connected',
          status: 'action-needed',
          detail: 'No machine registered yet. The MCP server will not start until you onboard the CLI on at least one machine.',
          gates: 'all tools',
          fix: 'styrby onboard',
        };

  const approvals: McpCheck =
    deviceTokenCount > 0
      ? {
          id: 'approvals',
          label: 'Mobile approvals',
          status: 'ready',
          detail: `${deviceTokenCount} device${deviceTokenCount === 1 ? '' : 's'} can receive approval prompts.`,
          gates: 'request_approval',
        }
      : {
          id: 'approvals',
          label: 'Mobile approvals',
          status: 'recommended',
          detail: 'No mobile device linked. request_approval still works, but you will only see prompts in the web dashboard, not pushed to your phone.',
          gates: 'request_approval',
          fix: 'Install the Styrby mobile app and sign in',
        };

  const teamPolicy: McpCheck = hasTeam
    ? {
        id: 'team-policy',
        label: 'Team policy',
        status: 'ready',
        detail: 'You are on a team, so get_team_policy returns the policy rules for your team.',
        gates: 'get_team_policy',
      }
    : {
        id: 'team-policy',
        label: 'Team policy',
        status: 'optional',
        detail: 'Not on a team. get_team_policy returns no policy, which is expected on an individual plan.',
        gates: 'get_team_policy',
      };

  return {
    overall: machineCount > 0 ? 'ready' : 'not-connected',
    checks: [cli, approvals, teamPolicy],
  };
}
