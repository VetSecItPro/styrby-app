/**
 * apiClient-backed team-policy handler for the MCP server.
 *
 * Implements the {@link TeamPolicyHandler} contract from `./server.ts` by
 * reading the calling user's active team governance policies through
 * `GET /api/v1/team-policies` (key-authenticated). The endpoint resolves the
 * user's team server-side from the API key, so no team id is passed from the
 * agent — an agent cannot probe another team's policies.
 *
 * @module mcp/teamPolicyHandler
 */

import type { TeamPolicyHandler } from './server.js';
import type { GetTeamPolicyInput, GetTeamPolicyOutput } from './tools.js';
import type { StyrbyApiClient } from '@/api/styrbyApiClient';

/**
 * Creates an apiClient-backed TeamPolicyHandler.
 *
 * @param apiClient - Authenticated StyrbyApiClient with the user's styrby_* key.
 * @returns A handler the MCP server uses to back the `get_team_policy` tool.
 */
export function createApiTeamPolicyHandler(apiClient: StyrbyApiClient): TeamPolicyHandler {
  return {
    async getPolicies(input: GetTeamPolicyInput): Promise<GetTeamPolicyOutput> {
      try {
        // agentType is advisory (server may use it to narrow in future); pass
        // it through so the contract is honoured even though the current
        // endpoint returns all enabled policies for the agent to reason over.
        return await apiClient.getTeamPolicies({ agentType: input.agentType });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        throw new Error(`Failed to fetch team policies: ${msg}`);
      }
    },
  };
}
