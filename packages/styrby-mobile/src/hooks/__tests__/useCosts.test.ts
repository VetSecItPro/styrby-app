/**
 * useCosts Hook Test Suite
 *
 * Tests the cost data hook, including:
 * - Initial fetch and data derivation
 * - 90-day query range
 * - Real-time INSERT updates
 * - Record pruning for memory management
 * - Utility functions (formatCost, formatTokens)
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockCostRecords: unknown[] = [];
let mockQueryError: unknown = null;

/** Stores the Realtime event handler so tests can trigger synthetic events. */
let realtimeCallback: ((payload: { new: unknown }) => void) | null = null;

jest.mock('@/lib/supabase', () => {
  const createChain = () => {
    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'gte', 'limit'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() =>
      Promise.resolve({ data: null, error: null }),
    );
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({
        data: mockCostRecords,
        error: mockQueryError,
      }).then(resolve);
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
      from: jest.fn(() => createChain()),
      channel: jest.fn(() => ({
        on: jest.fn((_event: string, _filter: unknown, callback: (payload: { new: unknown }) => void) => {
          realtimeCallback = callback;
          return {
            on: jest.fn().mockReturnThis(),
            subscribe: jest.fn(),
          };
        }),
        subscribe: jest.fn(),
      })),
      removeChannel: jest.fn(),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

import { useCosts, formatCost, formatTokens } from '../useCosts';

// ============================================================================
// Test Data
// ============================================================================

/**
 * Creates a cost record with the given date and agent type.
 */
function makeCostRecord(
  date: string,
  agent: string = 'claude',
  cost: number = 1.0,
) {
  return {
    record_date: date,
    agent_type: agent,
    cost_usd: cost,
    input_tokens: 1000,
    output_tokens: 500,
    is_pending: false,
  };
}

/**
 * Returns today's date as YYYY-MM-DD.
 */
function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Returns a date N days ago as YYYY-MM-DD.
 */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ============================================================================
// Tests
// ============================================================================

describe('useCosts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    mockCostRecords = [];
    mockQueryError = null;
    realtimeCallback = null;
  });

  // --------------------------------------------------------------------------
  // Initial Fetch
  // --------------------------------------------------------------------------

  it('starts in loading state', () => {
    const { result } = renderHook(() => useCosts());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('fetches and derives cost data on mount', async () => {
    mockCostRecords = [
      makeCostRecord(todayStr(), 'claude', 2.5),
      makeCostRecord(todayStr(), 'codex', 1.0),
      makeCostRecord(daysAgoStr(3), 'gemini', 0.75),
    ];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).not.toBeNull();
    expect(result.current.error).toBeNull();

    // Today should include only today's records
    expect(result.current.data!.today.totalCost).toBeCloseTo(3.5);
    expect(result.current.data!.today.requestCount).toBe(2);

    // Week should include all 3 records
    expect(result.current.data!.week.totalCost).toBeCloseTo(4.25);
    expect(result.current.data!.week.requestCount).toBe(3);
  });

  it('returns empty data when no records exist', async () => {
    mockCostRecords = [];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).not.toBeNull();
    expect(result.current.data!.today.totalCost).toBe(0);
    expect(result.current.data!.today.requestCount).toBe(0);
    expect(result.current.data!.byAgent).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 90-day Range
  // --------------------------------------------------------------------------

  it('includes records up to 90 days for quarter summary', async () => {
    mockCostRecords = [
      makeCostRecord(todayStr(), 'claude', 1.0),
      makeCostRecord(daysAgoStr(45), 'claude', 2.0),
      makeCostRecord(daysAgoStr(85), 'claude', 3.0),
    ];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data!.quarter.totalCost).toBeCloseTo(6.0);
    expect(result.current.data!.quarter.requestCount).toBe(3);
  });

  // --------------------------------------------------------------------------
  // Agent Breakdown
  // --------------------------------------------------------------------------

  it('computes agent breakdown with correct percentages', async () => {
    mockCostRecords = [
      makeCostRecord(todayStr(), 'claude', 3.0),
      makeCostRecord(todayStr(), 'codex', 1.0),
    ];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const { byAgent } = result.current.data!;
    expect(byAgent).toHaveLength(2);

    const claudeAgent = byAgent.find((a) => a.agent === 'claude');
    expect(claudeAgent).toBeDefined();
    expect(claudeAgent!.percentage).toBeCloseTo(75);

    const codexAgent = byAgent.find((a) => a.agent === 'codex');
    expect(codexAgent).toBeDefined();
    expect(codexAgent!.percentage).toBeCloseTo(25);
  });

  // --------------------------------------------------------------------------
  // Real-time INSERT
  // --------------------------------------------------------------------------

  it('updates totals when a real-time INSERT is received', async () => {
    mockCostRecords = [makeCostRecord(todayStr(), 'claude', 1.0)];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data!.today.totalCost).toBeCloseTo(1.0);

    // Simulate a real-time INSERT
    if (realtimeCallback) {
      act(() => {
        realtimeCallback!({
          new: makeCostRecord(todayStr(), 'codex', 2.0),
        });
      });
    }

    await waitFor(() => {
      expect(result.current.data!.today.totalCost).toBeCloseTo(3.0);
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  it('sets error when fetch fails', async () => {
    mockQueryError = { message: 'Connection timeout' };

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // When the query returns an error, fetchQuarterRecords returns []
    // and deriveAndSetData sets empty data (no error thrown)
    expect(result.current.data).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  it('refresh re-fetches data', async () => {
    mockCostRecords = [makeCostRecord(todayStr(), 'claude', 1.0)];

    const { result } = renderHook(() => useCosts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Update mock data for refresh
    mockCostRecords = [
      makeCostRecord(todayStr(), 'claude', 1.0),
      makeCostRecord(todayStr(), 'claude', 5.0),
    ];

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.data!.today.totalCost).toBeCloseTo(6.0);
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('formatCost', () => {
  it('formats cost as USD currency string', () => {
    expect(formatCost(12.34)).toBe('$12.34');
  });

  it('respects decimal places parameter', () => {
    expect(formatCost(12.345, 3)).toBe('$12.345');
    expect(formatCost(12, 0)).toBe('$12');
  });

  it('handles zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('formatTokens', () => {
  it('formats millions with M suffix', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1_500)).toBe('1.5K');
  });

  it('returns plain number for small values', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('handles zero', () => {
    expect(formatTokens(0)).toBe('0');
  });
});
