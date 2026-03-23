/**
 * useOnboarding Hook Test Suite
 *
 * Tests the onboarding progress hook, including:
 * - Initial loading state
 * - Checklist computation per subscription tier
 * - Completion detection from profiles.onboarding_completed_at
 * - markComplete mutation
 * - Error handling for unauthenticated users
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

/** Mutable state for controlling Supabase mock behavior per test. */
let mockAuthUser: { id: string } | null = { id: 'test-user-id' };

/**
 * Mock query results keyed by table name.
 * Each test can override these to simulate different database states.
 */
let mockQueryResults: Record<string, { data: unknown; error: unknown }> = {};

jest.mock('@/lib/supabase', () => {
  /**
   * Creates a chainable query builder mock that resolves to the
   * pre-configured result for the given table.
   */
  const createChain = (table: string) => {
    const getResult = () =>
      mockQueryResults[table] || { data: null, error: null };

    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'limit', 'order', 'gte', 'insert', 'update', 'delete'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(getResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(getResult()));
    // Make the chain itself thenable for queries that do not end in single()
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: null,
        })),
      },
      from: jest.fn((table: string) => createChain(table)),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

// Import AFTER mocks
import { useOnboarding } from '../useOnboarding';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Configures mock query results with sensible defaults for a fully complete
 * free-tier user (device paired, onboarding not completed).
 */
function setupDefaults(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  mockQueryResults = {
    profiles: {
      data: { onboarding_completed_at: null },
      error: null,
    },
    subscriptions: {
      data: { tier: 'free' },
      error: null,
    },
    machines: {
      data: [{ id: 'machine-1' }],
      error: null,
    },
    budget_alerts: { data: [], error: null },
    notification_preferences: { data: [], error: null },
    device_tokens: { data: [], error: null },
    team_members: { data: [], error: null },
    api_keys: { data: [], error: null },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('useOnboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    setupDefaults();
  });

  // --------------------------------------------------------------------------
  // Loading State
  // --------------------------------------------------------------------------

  it('starts in loading state', () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isLoading).toBe(true);
  });

  it('finishes loading after data is fetched', async () => {
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Tier-based Checklist
  // --------------------------------------------------------------------------

  it('shows 1 step for free tier', async () => {
    setupDefaults({
      subscriptions: { data: { tier: 'free' }, error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
    expect(result.current.totalCount).toBe(1);
    expect(result.current.steps[0].id).toBe('pair_device');
  });

  it('shows 3 steps for pro tier', async () => {
    setupDefaults({
      subscriptions: { data: { tier: 'pro' }, error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('pro');
    expect(result.current.totalCount).toBe(3);
    const stepIds = result.current.steps.map((s) => s.id);
    expect(stepIds).toContain('pair_device');
    expect(stepIds).toContain('set_budget_alert');
    expect(stepIds).toContain('configure_notifications');
  });

  it('shows 5 steps for power tier', async () => {
    setupDefaults({
      subscriptions: { data: { tier: 'power' }, error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('power');
    expect(result.current.totalCount).toBe(5);
  });

  it('defaults to free tier when no subscription exists', async () => {
    setupDefaults({
      subscriptions: { data: null, error: { message: 'No rows' } },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
  });

  // --------------------------------------------------------------------------
  // Completion Detection
  // --------------------------------------------------------------------------

  it('reports isComplete=true when onboarding_completed_at is set', async () => {
    setupDefaults({
      profiles: {
        data: { onboarding_completed_at: '2024-01-01T00:00:00Z' },
        error: null,
      },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isComplete).toBe(true);
  });

  it('reports isComplete=false when onboarding_completed_at is null', async () => {
    setupDefaults();

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isComplete).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Step Completion
  // --------------------------------------------------------------------------

  it('marks pair_device as completed when machines exist', async () => {
    setupDefaults({
      machines: { data: [{ id: 'machine-1' }], error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const pairStep = result.current.steps.find((s) => s.id === 'pair_device');
    expect(pairStep?.completed).toBe(true);
    expect(result.current.completedCount).toBe(1);
  });

  it('marks pair_device as not completed when no machines exist', async () => {
    setupDefaults({
      machines: { data: [], error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const pairStep = result.current.steps.find((s) => s.id === 'pair_device');
    expect(pairStep?.completed).toBe(false);
  });

  it('marks configure_notifications as completed if device_tokens exist', async () => {
    setupDefaults({
      subscriptions: { data: { tier: 'pro' }, error: null },
      notification_preferences: { data: [], error: null },
      device_tokens: { data: [{ id: 'token-1' }], error: null },
    });

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const notifStep = result.current.steps.find((s) => s.id === 'configure_notifications');
    expect(notifStep?.completed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // markComplete
  // --------------------------------------------------------------------------

  it('markComplete sets isComplete to true on success', async () => {
    setupDefaults();

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isComplete).toBe(false);

    await act(async () => {
      await result.current.markComplete();
    });

    expect(result.current.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  it('sets error when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('You must be signed in to view onboarding status.');
  });
});
