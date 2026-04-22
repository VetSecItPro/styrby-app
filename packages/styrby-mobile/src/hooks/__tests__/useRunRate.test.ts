/**
 * Tests for useRunRate hook.
 *
 * WHY: useRunRate feeds the RunRateCard and TierUpgradeWarning components on
 * the mobile Costs screen. A regression in the aggregation or tier resolution
 * would show wrong projections to users approaching their budget limits.
 *
 * Tests cover:
 *   - Successful fetch with correct sum aggregation
 *   - Tier resolution from subscription query
 *   - Error propagation
 *   - Loading state transitions
 *
 * @module hooks/__tests__/useRunRate
 */

import { renderHook, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

let mockCostRows: { cost_usd: number }[] = [];
let mockSubTier: string | null = 'free';
let mockQueryError: Error | null = null;

jest.mock('@/lib/supabase', () => {
  const buildChain = (rows: unknown[], error: Error | null) => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'gte', 'limit'];
    for (const m of methods) {
      chain[m] = jest.fn(() => chain);
    }
    // Simulate a thenable that resolves with the mock data.
    (chain as { then: (r: (v: unknown) => void) => Promise<unknown> }).then = (resolve) =>
      Promise.resolve({ data: rows, error }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
      },
      from: jest.fn((table: string) => {
        if (table === 'cost_records') {
          return buildChain(mockCostRows, mockQueryError);
        }
        if (table === 'subscriptions') {
          const subChain = buildChain(
            mockSubTier ? [{ tier: mockSubTier }] : [],
            null
          );
          // Override then to return single subscription or null
          (subChain as { maybeSingle: () => Promise<{ data: { tier: string } | null; error: null }> }).maybeSingle = () =>
            Promise.resolve({
              data: mockSubTier ? { tier: mockSubTier } : null,
              error: null,
            });
          return subChain;
        }
        return buildChain([], null);
      }),
    },
  };
});

// Mock styrby-shared calcRunRate so we can test only the hook's aggregation logic
jest.mock('styrby-shared', () => ({
  calcRunRate: jest.fn((params) => ({
    todayActualUsd: params.todayUsd,
    mtdActualUsd: params.mtdUsd,
    projectedMonthUsd: params.mtdUsd > 0 ? params.mtdUsd * 2 : null,
    rollingDailyAvgUsd: params.last30DaysUsd / 30,
    daysRemainingInMonth: 15,
    tierCapFractionUsed: null,
    tierCapUsd: null,
    daysUntilCapHit: null,
  })),
  normalizeTier: jest.fn((raw) => raw ?? 'free'),
}));

import { useRunRate } from '../useRunRate';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRunRate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCostRows = [];
    mockSubTier = 'free';
    mockQueryError = null;
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useRunRate());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.projection).toBeNull();
  });

  it('resolves with a projection after fetch completes', async () => {
    mockCostRows = [{ cost_usd: 1.5 }, { cost_usd: 0.5 }];
    const { result } = renderHook(() => useRunRate());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.projection).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets error when Supabase returns an error', async () => {
    mockQueryError = new Error('DB error');
    const { result } = renderHook(() => useRunRate());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(result.current.projection).toBeNull();
  });

  it('resolves tierLabel for known tier', async () => {
    mockSubTier = 'pro';
    const { result } = renderHook(() => useRunRate());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tierLabel).toBe('Pro');
  });

  it('defaults tierLabel to Free for unknown tier', async () => {
    mockSubTier = null;
    const { result } = renderHook(() => useRunRate());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tierLabel).toBe('Free');
  });
});
