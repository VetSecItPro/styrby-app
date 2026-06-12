/**
 * GET /api/v1/team-policies
 *
 * Returns the calling user's active team governance policies. Backs the CLI's
 * MCP `get_team_policy` tool so an agent can self-check a team's rules (cost
 * thresholds, agent/tool filters, time windows) BEFORE acting.
 *
 * The team is resolved server-side from the API key's user_id (never supplied
 * by the caller), so an agent cannot read another team's policies. Solo users
 * (no team membership) get `{ policies: [], hasTeam: false }`.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit default per-key (governance config is low-volume; no override)
 *
 * @returns 200 { policies: TeamPolicy[], hasTeam: boolean }
 *
 * @error 401 { error }  - Missing or invalid API key
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - team resolved from auth context, not the request.
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'read' scope sufficient (no mutation).
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

const ROUTE_ID = '/api/v1/team-policies';

/** Raw row shape from the team_policies table (snake_case, NUMERIC as string). */
interface TeamPolicyDbRow {
  name: string;
  description: string | null;
  rule_type: 'cost_threshold' | 'agent_filter' | 'tool_allowlist' | 'time_window';
  action: 'block' | 'require_approval' | 'allow_with_audit';
  threshold: number | string | null;
  agent_filter: string[] | null;
  priority: number;
}

/**
 * GET handler — wrapped by withApiAuthAndRateLimit (never called directly).
 *
 * @param _request - Authenticated NextRequest (no query params consumed yet;
 *   `agent_type` is accepted by the client for forward-compat but the endpoint
 *   intentionally returns ALL enabled policies for the agent to reason over).
 * @param authContext - Auth context (userId from the API key).
 * @returns 200 with { policies, hasTeam }, or a sanitized error.
 */
async function handleGet(_request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const supabase = createAdminClient();

  // 1. Resolve the user's team memberships. A user may belong to 0..N teams;
  //    we return the union of enabled policies across all their teams.
  const { data: memberships, error: memberErr } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId);

  if (memberErr) {
    Sentry.captureException(new Error(`team_members lookup error: ${memberErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to resolve team membership' }, { status: 500 });
  }

  const teamIds = (memberships ?? []).map((m) => (m as { team_id: string }).team_id);

  // 2. Solo user (no team): return empty + hasTeam=false. Distinguishing this
  //    from "team with zero policies" lets the agent reason correctly.
  if (teamIds.length === 0) {
    return NextResponse.json(
      { policies: [], hasTeam: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 3. Read enabled policies for the user's teams, priority-ordered.
  const { data: rows, error: policyErr } = await supabase
    .from('team_policies')
    .select('name, description, rule_type, action, threshold, agent_filter, priority')
    .in('team_id', teamIds)
    .eq('enabled', true)
    .order('priority', { ascending: true });

  if (policyErr) {
    Sentry.captureException(new Error(`team_policies read error: ${policyErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to read team policies' }, { status: 500 });
  }

  // 4. Map snake_case DB columns to the camelCase API contract. threshold is a
  //    Postgres NUMERIC which the driver may return as a string — coerce to a
  //    number (or null) so the client gets a stable numeric type.
  const policies = ((rows ?? []) as TeamPolicyDbRow[]).map((r) => ({
    name: r.name,
    description: r.description,
    ruleType: r.rule_type,
    action: r.action,
    threshold: r.threshold === null ? null : Number(r.threshold),
    agentFilter: r.agent_filter ?? [],
    priority: r.priority,
  }));

  return NextResponse.json(
    { policies, hasTeam: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * GET /api/v1/team-policies — required scope: ['read'].
 */
export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
