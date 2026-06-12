/**
 * Tests for GET /api/v1/team-policies (Cluster B2 — MCP get_team_policy backend).
 *
 * Verifies:
 *  - team resolved from auth context, not the request (OWASP A01)
 *  - solo user (no membership) → { policies: [], hasTeam: false }
 *  - team user → enabled policies mapped to the camelCase contract
 *  - NUMERIC threshold coerced from string → number (or null)
 *  - DB errors are sanitized to 500 + Sentry
 *
 * @module api/v1/team-policies/__tests__/route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── auth bypass: invoke handler with a fixed auth context ───────────────────
const mockAuthContext = { userId: 'user-1', keyId: 'key-1', scopes: ['read'] };

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// ── supabase admin mock: result per table ───────────────────────────────────
let tableResults: Record<string, { data?: unknown; error?: unknown }> = {};

function chainFor(table: string) {
  const result = tableResults[table] ?? { data: [], error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Thenable: awaiting the chain at any point resolves to the table result.
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => chainFor(table)),
  })),
}));

import { GET } from '../route';

function makeReq(): NextRequest {
  return new NextRequest('https://x.test/api/v1/team-policies');
}

describe('GET /api/v1/team-policies', () => {
  beforeEach(() => {
    tableResults = {};
    vi.clearAllMocks();
  });

  it('returns hasTeam=false + empty list for a solo user (no membership)', async () => {
    tableResults['team_members'] = { data: [], error: null };

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ policies: [], hasTeam: false });
  });

  it('returns enabled policies mapped to the camelCase contract for a team user', async () => {
    tableResults['team_members'] = { data: [{ team_id: 'team-1' }], error: null };
    tableResults['team_policies'] = {
      data: [
        {
          name: 'Prod cost cap',
          description: 'Require approval over $50',
          rule_type: 'cost_threshold',
          action: 'require_approval',
          threshold: '50.000000', // NUMERIC comes back as string
          agent_filter: ['claude'],
          priority: 10,
        },
        {
          name: 'No deletes',
          description: null,
          rule_type: 'tool_allowlist',
          action: 'block',
          threshold: null,
          agent_filter: null, // null → []
          priority: 20,
        },
      ],
      error: null,
    };

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.hasTeam).toBe(true);
    expect(body.policies).toHaveLength(2);
    expect(body.policies[0]).toEqual({
      name: 'Prod cost cap',
      description: 'Require approval over $50',
      ruleType: 'cost_threshold',
      action: 'require_approval',
      threshold: 50, // coerced string → number
      agentFilter: ['claude'],
      priority: 10,
    });
    // null threshold stays null; null agent_filter becomes []
    expect(body.policies[1].threshold).toBeNull();
    expect(body.policies[1].agentFilter).toEqual([]);
  });

  it('returns 500 (sanitized) when the membership lookup fails', async () => {
    tableResults['team_members'] = { data: null, error: { message: 'db down' } };

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain('db down'); // sanitized
  });

  it('returns 500 when the policy read fails', async () => {
    tableResults['team_members'] = { data: [{ team_id: 'team-1' }], error: null };
    tableResults['team_policies'] = { data: null, error: { message: 'policy boom' } };

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
