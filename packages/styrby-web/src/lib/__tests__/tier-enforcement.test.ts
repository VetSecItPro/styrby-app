/**
 * Tier Enforcement Tests
 *
 * Security-critical coverage for SEC-LOGIC-002: server-side billing tier cap
 * enforcement. This is the sole guard between a free-tier user and unlimited
 * resource consumption via direct API calls.
 *
 * Test design principles:
 * - Fail-closed paths are tested MORE than happy paths (security guarantee)
 * - No real DB calls — all Supabase interactions are vi.mock()'d
 * - Every exported symbol is covered
 * - Edge cases: null, undefined, malformed tier, DB down
 *
 * Compliance: SOC2 CC6.7 (system operation) + OWASP ASVS V11 (business logic)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkTierLimit,
  resolveEffectiveTier,
  rankTier,
  maxTier,
  normalizeEffectiveTier,
} from '../tier-enforcement';
import type {
  TierLimitResult,
  TierLimitAllowed,
  TierLimitBlocked,
  EffectiveTierId,
} from '../tier-enforcement';
import { TIER_LIMITS } from '@styrby/shared';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Supabase mock for the subscription + count query chain.
 *
 * @param tier - What the subscriptions table returns for the `tier` column.
 *               Pass `null` to simulate no active subscription.
 *               Pass `Error` to simulate a Supabase fetch error.
 * @param sessionCount - What the sessions count query returns.
 *                        Pass `Error` to simulate a count error.
 * @param agentCount - What the agent_configs count query returns.
 *                      Pass `Error` to simulate a count error.
 */
function buildSupabaseMock({
  tier,
  sessionCount = 0,
  agentCount = 0,
  teamBillingTiers = [],
  teamMembersError = false,
}: {
  tier: string | null | Error;
  sessionCount?: number | Error;
  agentCount?: number | Error;
  /**
   * Active team memberships for the user. Each entry yields one row from
   * `team_members` with a joined `teams.billing_tier` value. Default empty
   * (user is on no team).
   */
  teamBillingTiers?: Array<string | null>;
  /** When true, the team_members query resolves with an error. */
  teamMembersError?: boolean;
}) {
  const subscriptionResult =
    tier instanceof Error
      ? { data: null, error: { message: (tier as Error).message } }
      : tier === null
      ? { data: null, error: { message: 'No rows found' } }
      : { data: { tier }, error: null };

  // We need to support multiple .from() calls: 'subscriptions', 'team_members',
  // 'sessions', 'agent_configs'. We track the table name via the mock.
  const fromMock = vi.fn((table: string) => {
    if (table === 'subscriptions') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue(subscriptionResult),
      };
    }
    if (table === 'team_members') {
      // The resolver runs `.from('team_members').select('teams!inner(billing_tier)').eq('user_id', userId)`
      // which terminates on the .eq() call.
      const teamRows = teamBillingTiers.map((bt) => ({ teams: { billing_tier: bt } }));
      const res = teamMembersError
        ? { data: null, error: { message: 'team_members unavailable' } }
        : { data: teamRows, error: null };
      const eqMock = vi.fn().mockResolvedValue(res);
      return {
        select: vi.fn().mockReturnThis(),
        eq: eqMock,
      };
    }
    if (table === 'sessions') {
      const res =
        sessionCount instanceof Error
          ? { count: null, error: { message: (sessionCount as Error).message } }
          : { count: sessionCount, error: null };
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockResolvedValue(res),
      };
    }
    if (table === 'agent_configs') {
      // The agent count query is: .from('agent_configs').select(...).eq('user_id', userId)
      // It ends on the second call — resolve from eq.
      const res =
        agentCount instanceof Error
          ? { count: null, error: { message: (agentCount as Error).message } }
          : { count: agentCount, error: null };
      const eqMock = vi.fn().mockResolvedValue(res);
      return {
        select: vi.fn().mockReturnThis(),
        eq: eqMock,
      };
    }
    // Unknown table — fail safely
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Unknown table' } }),
      gte: vi.fn().mockResolvedValue({ count: null, error: { message: 'Unknown table' } }),
    };
  });

  return { from: fromMock } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

const USER_ID = 'test-user-uuid-1234';

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

function isAllowed(r: TierLimitResult): r is TierLimitAllowed {
  return r.allowed === true;
}

function isBlocked(r: TierLimitResult): r is TierLimitBlocked {
  return r.allowed === false;
}

// ---------------------------------------------------------------------------
// checkTierLimit — Happy paths (free tier)
// ---------------------------------------------------------------------------

describe('checkTierLimit — free tier (maxSessionsPerDay)', () => {
  it('allows sessions when under the free limit', async () => {
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: 4 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('allows sessions at exactly one below the free limit (boundary)', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit - 1 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('blocks sessions exactly at the free limit (boundary)', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.limit).toBe(freeLimit);
      expect(result.current).toBe(freeLimit);
      expect(result.tier).toBe('free');
      expect(result.upgradeUrl).toBe('/pricing');
    }
  });

  it('blocks sessions one above the free limit', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit + 1 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.current).toBe(freeLimit + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// checkTierLimit — Happy paths (free tier, maxAgents)
// ---------------------------------------------------------------------------

describe('checkTierLimit — free tier (maxAgents)', () => {
  it('allows when agent count is under the free limit', async () => {
    const supabase = buildSupabaseMock({ tier: 'free', agentCount: 0 });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('blocks at the free agent limit (boundary)', async () => {
    const freeAgentLimit = TIER_LIMITS.free.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'free', agentCount: freeAgentLimit });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.limit).toBe(freeAgentLimit);
      expect(result.current).toBe(freeAgentLimit);
      expect(result.tier).toBe('free');
      expect(result.upgradeUrl).toBe('/pricing');
    }
  });

  it('blocks when agent count exceeds the free limit', async () => {
    const freeAgentLimit = TIER_LIMITS.free.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'free', agentCount: freeAgentLimit + 5 });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.current).toBeGreaterThan(result.limit);
    }
  });
});

// ---------------------------------------------------------------------------
// checkTierLimit — Pro tier (Infinity sessions)
// ---------------------------------------------------------------------------

describe('checkTierLimit — pro tier (Infinity sessions)', () => {
  it('always allows sessions for pro (Infinity limit, no DB count query)', async () => {
    const supabase = buildSupabaseMock({ tier: 'pro' });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('does NOT query sessions table when pro tier has Infinity limit', async () => {
    const supabase = buildSupabaseMock({ tier: 'pro' });
    const fromSpy = supabase.from as ReturnType<typeof vi.fn>;
    await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    // Only subscriptions table should be queried, not sessions
    const tablesQueried = fromSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(tablesQueried).toContain('subscriptions');
    expect(tablesQueried).not.toContain('sessions');
  });

  it('enforces maxAgents for pro tier at boundary', async () => {
    const proAgentLimit = TIER_LIMITS.pro.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'pro', agentCount: proAgentLimit });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.limit).toBe(proAgentLimit);
      expect(result.tier).toBe('pro');
    }
  });

  it('allows maxAgents for pro tier under limit', async () => {
    const proAgentLimit = TIER_LIMITS.pro.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'pro', agentCount: proAgentLimit - 1 });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isAllowed(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkTierLimit — Power tier (Infinity sessions, higher agents)
// ---------------------------------------------------------------------------

describe('checkTierLimit — power tier', () => {
  it('always allows sessions for power (Infinity limit)', async () => {
    const supabase = buildSupabaseMock({ tier: 'power' });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('does NOT query sessions table when power tier has Infinity limit', async () => {
    const supabase = buildSupabaseMock({ tier: 'power' });
    const fromSpy = supabase.from as ReturnType<typeof vi.fn>;
    await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    const tablesQueried = fromSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(tablesQueried).not.toContain('sessions');
  });

  it('enforces maxAgents for power tier at boundary', async () => {
    const powerAgentLimit = TIER_LIMITS.power.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'power', agentCount: powerAgentLimit });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.limit).toBe(powerAgentLimit);
      expect(result.tier).toBe('power');
    }
  });

  it('allows maxAgents for power tier under limit', async () => {
    const powerAgentLimit = TIER_LIMITS.power.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'power', agentCount: powerAgentLimit - 1 });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('power tier has higher maxAgents than pro tier', () => {
    // Regression guard: SEC-BIZ-003 fix set power to 9 agents.
    // If someone reverts that, this test catches it immediately.
    expect(TIER_LIMITS.power.maxAgents).toBeGreaterThan(TIER_LIMITS.pro.maxAgents);
    expect(TIER_LIMITS.power.maxAgents).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// checkTierLimit — Team tier (Infinity sessions)
// ---------------------------------------------------------------------------

describe('checkTierLimit — team tier', () => {
  it('always allows sessions for team (Infinity limit)', async () => {
    const supabase = buildSupabaseMock({ tier: 'team' });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('enforces maxAgents for team tier', async () => {
    const teamAgentLimit = TIER_LIMITS.team.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'team', agentCount: teamAgentLimit });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      // WHY (Phase 0.10): tier resolution now delegates to the shared
      // `normalizeTier` helper which recognises 'team' as a valid tier id
      // (the Teams plan is reserved for future GA but the id itself is
      // canonical). Web and mobile both agree on this normalisation.
      expect(result.tier).toBe('team');
      expect(result.limit).toBe(teamAgentLimit);
    }
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED BEHAVIOR — Core security guarantee
// ---------------------------------------------------------------------------

describe('checkTierLimit — fail-closed: Supabase tier lookup failure', () => {
  it('defaults to free tier when subscription query returns error', async () => {
    const supabase = buildSupabaseMock({
      tier: new Error('connection timeout'),
      sessionCount: 0,
    });
    // With free tier defaults, sessionCount=0 should still be allowed
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('defaults to free tier limits when subscription query returns null', async () => {
    // Supabase returns no rows — user has no active subscription
    const supabase = buildSupabaseMock({ tier: null, sessionCount: 0 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
    // But they should still hit the free cap
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const blockedSupabase = buildSupabaseMock({ tier: null, sessionCount: freeLimit });
    const blockedResult = await checkTierLimit(USER_ID, 'maxSessionsPerDay', blockedSupabase);
    expect(isBlocked(blockedResult)).toBe(true);
    if (isBlocked(blockedResult)) {
      expect(blockedResult.tier).toBe('free');
    }
  });

  it('blocks when tier lookup fails AND session count hits free limit', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({
      tier: new Error('network error'),
      sessionCount: freeLimit,
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      // Must default to the free (most restrictive) tier — not pro/power
      expect(result.tier).toBe('free');
      expect(result.limit).toBe(freeLimit);
      expect(result.upgradeUrl).toBe('/pricing');
    }
  });

  it('blocks maxAgents when tier lookup fails AND agent count hits free limit', async () => {
    const freeAgentLimit = TIER_LIMITS.free.maxAgents as number;
    const supabase = buildSupabaseMock({
      tier: new Error('DB unavailable'),
      agentCount: freeAgentLimit,
    });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('free');
      expect(result.limit).toBe(freeAgentLimit);
    }
  });

  it('NEVER grants Infinity access when tier lookup fails (fail-closed, not fail-open)', async () => {
    // This is the critical regression test: if someone changes the default
    // from 'free' to 'pro'/'power', free users would get unlimited sessions.
    const supabase = buildSupabaseMock({
      tier: new Error('DB down'),
      sessionCount: 999, // Way above free limit
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    // Should be BLOCKED, not allowed
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      // Must be free tier default, not an Infinity tier
      expect(isFinite(result.limit)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — Unknown / malformed tier values
// ---------------------------------------------------------------------------

describe('checkTierLimit — fail-closed: unknown or malformed tier', () => {
  it('defaults to free when tier is a typo / unknown string', async () => {
    // Post SEC-ADV-004 the resolver recognises all 6 canonical tier ids
    // (free / pro / power / team / business / enterprise) — anything else
    // (typos, future values, escalation attempts) MUST fall back to free.
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const blockedSupabase = buildSupabaseMock({
      tier: 'super-admin',
      sessionCount: freeLimit,
    });
    const blockedResult = await checkTierLimit(USER_ID, 'maxSessionsPerDay', blockedSupabase);
    expect(isBlocked(blockedResult)).toBe(true);
    if (isBlocked(blockedResult)) {
      expect(blockedResult.tier).toBe('free');
    }
  });

  it('defaults to free when tier is a SQL injection attempt string', async () => {
    const supabase = buildSupabaseMock({
      tier: "'; DROP TABLE subscriptions; --",
      sessionCount: 0,
    });
    // Should not throw, should default to free
    await expect(
      checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase)
    ).resolves.toBeDefined();
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const blockedSupabase = buildSupabaseMock({
      tier: "'; DROP TABLE subscriptions; --",
      sessionCount: freeLimit,
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', blockedSupabase);
    expect(isBlocked(result)).toBe(true);
  });

  it('defaults to free when tier is empty string', async () => {
    // empty string → not in knownTiers → 'free'
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const blockedSupabase = buildSupabaseMock({ tier: '', sessionCount: freeLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', blockedSupabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('free');
    }
  });

  it('defaults to free when tier is "admin" (escalation attempt)', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const blockedSupabase = buildSupabaseMock({ tier: 'admin', sessionCount: freeLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', blockedSupabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('free');
    }
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — Count query failures
// ---------------------------------------------------------------------------

describe('checkTierLimit — fail-open for counting (returns 0 on error)', () => {
  it('returns count=0 when sessions query errors (does not hard-block user)', async () => {
    // WHY: The count query failing should not lock a user out entirely.
    // The fail-open for counting is intentional: the tier check itself still
    // enforces the limit (count=0 < limit → allowed).
    const supabase = buildSupabaseMock({
      tier: 'free',
      sessionCount: new Error('sessions table unavailable'),
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    // count=0 < freeLimit → allowed (fail-open for counting)
    expect(isAllowed(result)).toBe(true);
  });

  it('returns count=0 when agent_configs query errors (does not hard-block user)', async () => {
    const supabase = buildSupabaseMock({
      tier: 'free',
      agentCount: new Error('agent_configs table unavailable'),
    });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    // count=0 < freeAgentLimit → allowed (fail-open for counting)
    expect(isAllowed(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response shape and actionable messages
// ---------------------------------------------------------------------------

describe('checkTierLimit — blocked response shape', () => {
  it('blocked result includes upgradeUrl pointing to /pricing', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.upgradeUrl).toBe('/pricing');
    }
  });

  it('blocked result includes numeric limit (not Infinity)', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit + 2 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(isFinite(result.limit)).toBe(true);
      expect(typeof result.limit).toBe('number');
    }
  });

  it('blocked result includes the current count so callers can show "X of Y used"', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const overLimit = freeLimit + 3;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: overLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.current).toBe(overLimit);
    }
  });

  it('blocked result includes the resolved tier so callers can show upgrade path', async () => {
    const freeAgentLimit = TIER_LIMITS.free.maxAgents as number;
    const supabase = buildSupabaseMock({ tier: 'free', agentCount: freeAgentLimit });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('free');
    }
  });

  it('allowed result has exactly { allowed: true } shape (no extra fields)', async () => {
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: 0 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// TypeScript-level: exported types are correct
// ---------------------------------------------------------------------------

describe('checkTierLimit — return type guarantees', () => {
  it('returns TierLimitAllowed when under limit', async () => {
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: 0 });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    // Type narrowing must work
    if (result.allowed) {
      const _typeCheck: TierLimitAllowed = result; // TS would fail to compile if wrong
      expect(_typeCheck.allowed).toBe(true);
    }
  });

  it('returns TierLimitBlocked with all required fields when over limit', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: freeLimit });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    if (!result.allowed) {
      const blocked: TierLimitBlocked = result;
      expect(blocked).toHaveProperty('allowed', false);
      expect(blocked).toHaveProperty('limit');
      expect(blocked).toHaveProperty('current');
      expect(blocked).toHaveProperty('tier');
      expect(blocked).toHaveProperty('upgradeUrl');
    }
  });
});

// ---------------------------------------------------------------------------
// Rolling 24-hour window (sessions) — not midnight-reset
// ---------------------------------------------------------------------------

describe('checkTierLimit — rolling 24-hour window logic', () => {
  it('counts sessions from the past 24 hours only (not all sessions)', async () => {
    // This test verifies the supabase query uses .gte('started_at', windowStart)
    // We verify the sessions table is queried with a .gte call (not .eq)
    const supabase = buildSupabaseMock({ tier: 'free', sessionCount: 3 });
    const fromSpy = supabase.from as ReturnType<typeof vi.fn>;

    await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);

    // Find the sessions mock to check .gte was called
    const sessionsCallIndex = fromSpy.mock.calls.findIndex((c: unknown[]) => c[0] === 'sessions');
    expect(sessionsCallIndex).toBeGreaterThanOrEqual(0);

    const sessionsMock = fromSpy.mock.results[sessionsCallIndex].value;
    expect(sessionsMock.gte).toHaveBeenCalledWith(
      'started_at',
      expect.any(String)
    );

    // Verify the windowStart is approximately 24 hours ago
    const windowStartArg = sessionsMock.gte.mock.calls[0][1] as string;
    const windowStart = new Date(windowStartArg).getTime();
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    // Allow 5 second tolerance for test execution time
    expect(Math.abs(windowStart - twentyFourHoursAgo)).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Regression: tier escalation via bypassing tier resolution
// ---------------------------------------------------------------------------

describe('checkTierLimit — regression: cannot escalate tier via count manipulation', () => {
  it('a free user with 0 sessions is still subject to the free session limit, not pro/power', async () => {
    // Allowed now, but just before the limit
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    expect(freeLimit).toBeGreaterThan(0);
    expect(isFinite(freeLimit)).toBe(true);
    // Confirm free tier limit is NOT Infinity
    expect(freeLimit).not.toBe(Infinity);
  });

  it('a free user cannot reach pro-level Infinity by getting 0 from count query', async () => {
    // If count query returns 0 (error fallback), user still cannot exceed free limits
    const supabase = buildSupabaseMock({
      tier: 'free',
      sessionCount: new Error('count failed'),
    });
    // Returns 0 by fail-open, but tier is still free — so at 0 they're fine
    // This confirms that count=0 does NOT grant Infinity
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true); // 0 < freeLimit

    // Now confirm the limit being compared is finite (free), not Infinity
    const proSupabase = buildSupabaseMock({
      tier: 'free',
      sessionCount: TIER_LIMITS.free.maxSessionsPerDay as number,
    });
    const blockedResult = await checkTierLimit(USER_ID, 'maxSessionsPerDay', proSupabase);
    expect(isBlocked(blockedResult)).toBe(true); // still hits free cap
  });
});

// ---------------------------------------------------------------------------
// TIER_LIMITS shape validation — catch regressions in constants
// ---------------------------------------------------------------------------

describe('TIER_LIMITS constants — shape validation', () => {
  it('free tier has finite maxSessionsPerDay', () => {
    expect(isFinite(TIER_LIMITS.free.maxSessionsPerDay as number)).toBe(true);
    expect(TIER_LIMITS.free.maxSessionsPerDay).toBeGreaterThan(0);
  });

  it('free tier has finite maxAgents', () => {
    expect(isFinite(TIER_LIMITS.free.maxAgents)).toBe(true);
    expect(TIER_LIMITS.free.maxAgents).toBeGreaterThan(0);
  });

  it('pro tier has Infinity maxSessionsPerDay', () => {
    expect(isFinite(TIER_LIMITS.pro.maxSessionsPerDay as number)).toBe(false);
    expect(TIER_LIMITS.pro.maxSessionsPerDay).toBe(Infinity);
  });

  it('power tier has Infinity maxSessionsPerDay', () => {
    expect(isFinite(TIER_LIMITS.power.maxSessionsPerDay as number)).toBe(false);
    expect(TIER_LIMITS.power.maxSessionsPerDay).toBe(Infinity);
  });

  it('power maxAgents (9) is the SEC-BIZ-003 fix value', () => {
    // Regression guard for SEC-BIZ-003: power was previously capped at 3,
    // contradicting the billing definition. Any revert here breaks this test.
    expect(TIER_LIMITS.power.maxAgents).toBe(9);
  });

  it('free maxAgents is less than pro maxAgents', () => {
    expect(TIER_LIMITS.free.maxAgents).toBeLessThan(TIER_LIMITS.pro.maxAgents);
  });

  it('pro maxAgents is less than power maxAgents', () => {
    expect(TIER_LIMITS.pro.maxAgents).toBeLessThan(TIER_LIMITS.power.maxAgents);
  });
});

// ---------------------------------------------------------------------------
// SEC-ADV-004 — Tier ordering helpers
// ---------------------------------------------------------------------------

describe('rankTier — canonical tier ordering', () => {
  it('ranks all 6 known tiers monotonically', () => {
    expect(rankTier('free')).toBe(0);
    expect(rankTier('pro')).toBe(1);
    expect(rankTier('power')).toBe(2);
    expect(rankTier('team')).toBe(3);
    expect(rankTier('business')).toBe(4);
    expect(rankTier('enterprise')).toBe(5);
  });

  it('returns 0 (free) for an unknown tier — fail-closed', () => {
    // @ts-expect-error — feeding an invalid string on purpose to exercise
    // the fail-closed branch. Production callers always pass a typed value.
    expect(rankTier('hacker-tier')).toBe(0);
  });
});

describe('maxTier — picks the higher-ranked tier', () => {
  it('returns the higher of two tiers', () => {
    expect(maxTier('free', 'business')).toBe('business');
    expect(maxTier('power', 'team')).toBe('team');
    expect(maxTier('enterprise', 'free')).toBe('enterprise');
  });

  it('returns either when tiers are equal', () => {
    expect(maxTier('team', 'team')).toBe('team');
  });

  it('handles power vs pro correctly (power > pro)', () => {
    expect(maxTier('pro', 'power')).toBe('power');
  });
});

describe('normalizeEffectiveTier — input sanitisation', () => {
  it('preserves known tier ids', () => {
    const all: EffectiveTierId[] = ['free', 'pro', 'power', 'team', 'business', 'enterprise'];
    for (const t of all) {
      expect(normalizeEffectiveTier(t)).toBe(t);
    }
  });

  it('falls back to free for null / undefined / unknown', () => {
    expect(normalizeEffectiveTier(null)).toBe('free');
    expect(normalizeEffectiveTier(undefined)).toBe('free');
    expect(normalizeEffectiveTier('')).toBe('free');
    expect(normalizeEffectiveTier('admin')).toBe('free');
    expect(normalizeEffectiveTier("'; DROP TABLE --")).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// SEC-ADV-004 — resolveEffectiveTier cross-read
// ---------------------------------------------------------------------------

describe('resolveEffectiveTier — personal vs team cross-read', () => {
  it('user with no team and free personal sub → free', async () => {
    const supabase = buildSupabaseMock({ tier: 'free', teamBillingTiers: [] });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('free');
  });

  it('user with no team but power personal sub → power (preserves current behaviour)', async () => {
    const supabase = buildSupabaseMock({ tier: 'power', teamBillingTiers: [] });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('power');
  });

  it('user with personal=free + team=business → business (THE BUG FIX)', async () => {
    // SEC-ADV-004 happy path: a team admin whose team pays for business but
    // who has no personal subscription must receive business-tier access.
    const supabase = buildSupabaseMock({
      tier: null,
      teamBillingTiers: ['business'],
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('business');
  });

  it('user with personal=enterprise (admin override) + team=team → enterprise (personal outranks team)', async () => {
    // Admin-overridden personal tier must be honored when above the team tier.
    // Canonical TIER_ORDER: free < pro < power < team < business < enterprise.
    const supabase = buildSupabaseMock({
      tier: 'enterprise',
      teamBillingTiers: ['team'],
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('enterprise');
  });

  it('user with personal=power + team=team → team (team outranks power per canonical order)', async () => {
    // Pins the documented ordering: team-family always >= solo tiers.
    const supabase = buildSupabaseMock({
      tier: 'power',
      teamBillingTiers: ['team'],
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('team');
  });

  it('user on multiple teams → max team tier wins', async () => {
    const supabase = buildSupabaseMock({
      tier: 'free',
      teamBillingTiers: ['team', 'enterprise', 'business'],
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('enterprise');
  });

  it('team_members query error → falls back to personal tier (fail-closed for team component)', async () => {
    const supabase = buildSupabaseMock({
      tier: 'power',
      teamMembersError: true,
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('power');
  });

  it('both reads fail → free (fail-closed end-to-end)', async () => {
    const supabase = buildSupabaseMock({
      tier: new Error('subs down'),
      teamMembersError: true,
    });
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('free');
  });

  it('team billing_tier with unknown value is normalised to free, does not poison max', async () => {
    const supabase = buildSupabaseMock({
      tier: 'pro',
      teamBillingTiers: ['??? rogue value', null],
    });
    // pro outranks normalised free → effective is pro
    expect(await resolveEffectiveTier(supabase, USER_ID)).toBe('pro');
  });
});

// ---------------------------------------------------------------------------
// SEC-ADV-004 — checkTierLimit honors team billing
// ---------------------------------------------------------------------------

describe('checkTierLimit — team-tier elevation via teams.billing_tier', () => {
  it('free personal + business team → maxSessionsPerDay is unlimited', async () => {
    // Without the cross-read, this user would be blocked at the free 5/day cap.
    // With the fix, business has Infinity sessions so they pass without a count.
    const supabase = buildSupabaseMock({
      tier: null,
      teamBillingTiers: ['business'],
      sessionCount: 9999,
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('free personal + enterprise team → maxAgents follows enterprise caps', async () => {
    const enterpriseAgents = TIER_LIMITS.enterprise.maxAgents as number;
    const supabase = buildSupabaseMock({
      tier: null,
      teamBillingTiers: ['enterprise'],
      agentCount: enterpriseAgents - 1,
    });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isAllowed(result)).toBe(true);
  });

  it('free personal + enterprise team at agent cap → blocked, tier="enterprise"', async () => {
    const enterpriseAgents = TIER_LIMITS.enterprise.maxAgents as number;
    const supabase = buildSupabaseMock({
      tier: null,
      teamBillingTiers: ['enterprise'],
      agentCount: enterpriseAgents,
    });
    const result = await checkTierLimit(USER_ID, 'maxAgents', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('enterprise');
      expect(result.limit).toBe(enterpriseAgents);
    }
  });

  it('admin override (personal=power) above team=team is honored', async () => {
    // Admin set personal to power; team is on the team plan. Power outranks
    // team in the canonical ordering only if personal is the max — but here
    // team (rank 3) > power (rank 2), so team wins. This test pins the
    // ordering documented in TIER_ORDER.
    const supabase = buildSupabaseMock({
      tier: 'power',
      teamBillingTiers: ['team'],
      sessionCount: 0,
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    // Both power and team have Infinity sessions → allowed without a count query.
    expect(isAllowed(result)).toBe(true);
  });

  it('user on no team behaves identically to pre-SEC-ADV-004 (regression guard)', async () => {
    const freeLimit = TIER_LIMITS.free.maxSessionsPerDay as number;
    const supabase = buildSupabaseMock({
      tier: 'free',
      teamBillingTiers: [],
      sessionCount: freeLimit,
    });
    const result = await checkTierLimit(USER_ID, 'maxSessionsPerDay', supabase);
    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.tier).toBe('free');
    }
  });
});
