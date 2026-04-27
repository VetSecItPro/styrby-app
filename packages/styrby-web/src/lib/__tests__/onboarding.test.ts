/**
 * Tests for lib/onboarding.ts — getOnboardingState
 *
 * WHY: Onboarding state drives the welcome modal and sidebar banner shown to
 * new users. Regressions could leave users stuck in onboarding (isComplete
 * never true), show wrong steps for a tier, or fail to take the fast path
 * when onboarding_completed_at is already set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOnboardingState } from '../onboarding';

// ============================================================================
// Mock Supabase client builder
// ============================================================================

type QueryResult = { data?: unknown; error?: unknown; count?: number };

/**
 * Builds a minimal Supabase mock that returns results from a queue.
 * Each .from() call consumes one item from the queue.
 */
function buildMockSupabase(queue: QueryResult[]): SupabaseClient {
  const idx = { current: 0 };

  function makeChain(): Record<string, unknown> {
    const result = queue[idx.current++] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};

    const chainable = [
      'from', 'select', 'eq', 'is', 'order', 'limit',
      'insert', 'update', 'delete', 'single', 'maybeSingle',
    ];
    for (const method of chainable) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }

    chain['single'] = vi.fn().mockResolvedValue(result);
    chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
    chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

    return chain;
  }

  return {
    from: vi.fn(() => makeChain()),
  } as unknown as SupabaseClient;
}

// ============================================================================
// Tests
// ============================================================================

describe('getOnboardingState', () => {
  const USER_ID = 'onboard-user-xyz';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Fast path: already completed
  // --------------------------------------------------------------------------

  it('returns isComplete: true when onboarding_completed_at is set', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: '2026-01-01T00:00:00Z' }, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.isComplete).toBe(true);
    expect(state.onboardingCompletedAt).toBe('2026-01-01T00:00:00Z');
    // Fast path returns minimal state (no steps)
    expect(state.steps).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Free tier — 1 step
  // --------------------------------------------------------------------------

  it('shows 1 step for free tier user with no machine', async () => {
    const supabase = buildMockSupabase([
      // profiles → no completed_at
      { data: { onboarding_completed_at: null }, error: null },
      // subscriptions → free (null = free default)
      { data: null, error: null },
      // machines count → 0
      { count: 0, data: null, error: null },
      // budget_alerts count → 0
      { count: 0, data: null, error: null },
      // device_tokens count → 0
      { count: 0, data: null, error: null },
      // team_members count → 0
      { count: 0, data: null, error: null },
      // api_keys count → 0
      { count: 0, data: null, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.tier).toBe('free');
    expect(state.totalSteps).toBe(1);
    expect(state.completedCount).toBe(0);
    expect(state.isComplete).toBe(false);
    expect(state.steps[0].id).toBe('connect-machine');
    expect(state.steps[0].completed).toBe(false);
  });

  it('returns isComplete: true for free tier user who has connected a machine', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: null, error: null }, // free tier
      { count: 1, data: null, error: null }, // has machine
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.isComplete).toBe(true);
    expect(state.completedCount).toBe(1);
    expect(state.steps[0].completed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Pro tier — 3 steps
  // --------------------------------------------------------------------------

  it('shows 3 steps for pro tier user', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: { tier: 'pro' }, error: null },
      { count: 0, data: null, error: null }, // machines
      { count: 0, data: null, error: null }, // budget_alerts
      { count: 0, data: null, error: null }, // device_tokens
      { count: 0, data: null, error: null }, // team_members
      { count: 0, data: null, error: null }, // api_keys
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.tier).toBe('pro');
    expect(state.totalSteps).toBe(3);
    const stepIds = state.steps.map((s) => s.id);
    expect(stepIds).toContain('connect-machine');
    expect(stepIds).toContain('set-budget-alert');
    expect(stepIds).toContain('install-mobile-app');
  });

  it('reflects partial completion for pro user', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: { tier: 'pro' }, error: null },
      { count: 1, data: null, error: null }, // has machine ✓
      { count: 0, data: null, error: null }, // no budget alert
      { count: 1, data: null, error: null }, // has device token ✓
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.completedCount).toBe(2);
    expect(state.totalSteps).toBe(3);
    expect(state.isComplete).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Growth tier — 5 steps
  // --------------------------------------------------------------------------

  it('shows 5 steps for growth tier user', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: { tier: 'growth' }, error: null },
      { count: 0, data: null, error: null }, // machines
      { count: 0, data: null, error: null }, // budget_alerts
      { count: 0, data: null, error: null }, // device_tokens
      { count: 0, data: null, error: null }, // team_members
      { count: 0, data: null, error: null }, // api_keys
      // team_invitations (growth-only check)
      { count: 0, data: null, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    expect(state.tier).toBe('growth');
    expect(state.totalSteps).toBe(5);
    const stepIds = state.steps.map((s) => s.id);
    expect(stepIds).toContain('invite-team-member');
    expect(stepIds).toContain('create-api-key');
  });

  it('marks invite-team-member complete when there are sent invitations', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: { tier: 'growth' }, error: null },
      { count: 1, data: null, error: null }, // machine
      { count: 1, data: null, error: null }, // budget alert
      { count: 1, data: null, error: null }, // device token
      { count: 0, data: null, error: null }, // team_members (unused)
      { count: 1, data: null, error: null }, // api_keys
      { count: 2, data: null, error: null }, // team_invitations → invited someone
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    const teamStep = state.steps.find((s) => s.id === 'invite-team-member');
    expect(teamStep!.completed).toBe(true);
    expect(state.completedCount).toBe(5);
    expect(state.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Step metadata
  // --------------------------------------------------------------------------

  it('each step has required fields (id, label, description, href)', async () => {
    const supabase = buildMockSupabase([
      { data: { onboarding_completed_at: null }, error: null },
      { data: { tier: 'growth' }, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
      { count: 0, data: null, error: null },
    ]);

    const state = await getOnboardingState(supabase, USER_ID);

    for (const step of state.steps) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
      expect(step.description).toBeTruthy();
      expect(step.href).toMatch(/^\//);
    }
  });
});
