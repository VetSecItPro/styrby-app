/**
 * Budget RPC (checkHardStop) Test Suite
 *
 * Tests the check_budget_hard_stop RPC function invoked by useBudgetAlerts.
 * The RPC uses an advisory lock to atomically check whether the user has
 * exceeded a hard-stop budget threshold.
 *
 * Tests cover:
 * - checkHardStop returns correct not-blocked result
 * - checkHardStop returns correct blocked result
 * - Error handling for RPC failures
 * - Zod validation of the RPC response
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockRpcResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockQueryResults: Record<string, { data: unknown; error: unknown }> = {};

jest.mock('@/lib/supabase', () => {
  const createChain = (table: string) => {
    const getResult = () =>
      mockQueryResults[table] || { data: null, error: null };

    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'gte', 'limit', 'insert', 'update', 'delete'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(getResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(getResult()));
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
      rpc: jest.fn(() => Promise.resolve(mockRpcResult)),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

import { useBudgetAlerts } from '../hooks/useBudgetAlerts';
import { supabase } from '@/lib/supabase';

// ============================================================================
// Tests
// ============================================================================

describe('checkHardStop (Budget RPC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { id: 'test-user-id' };
    mockRpcResult = { data: null, error: null };
    // Default: no alerts, free tier
    mockQueryResults = {
      budget_alerts: { data: [], error: null },
      subscriptions: { data: null, error: null },
      cost_records: { data: [], error: null },
    };
  });

  // --------------------------------------------------------------------------
  // Not Blocked
  // --------------------------------------------------------------------------

  it('returns is_blocked=false when no hard-stop alert is triggered', async () => {
    // RPC returns empty array (no triggered alerts)
    mockRpcResult = { data: [], error: null };

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = null;
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toEqual({
      is_blocked: false,
      alert_id: null,
      threshold_usd: null,
      total_spend: null,
      period: null,
    });
  });

  // --------------------------------------------------------------------------
  // Blocked
  // --------------------------------------------------------------------------

  it('returns is_blocked=true with alert details when threshold exceeded', async () => {
    mockRpcResult = {
      data: [
        {
          is_blocked: true,
          alert_id: 'alert-1',
          threshold_usd: 10.0,
          total_spend: 12.5,
          period: 'daily',
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = null;
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toEqual({
      is_blocked: true,
      alert_id: 'alert-1',
      threshold_usd: 10.0,
      total_spend: 12.5,
      period: 'daily',
    });
  });

  it('handles string numeric values from Postgres (coercion)', async () => {
    mockRpcResult = {
      data: [
        {
          is_blocked: true,
          alert_id: 'alert-2',
          threshold_usd: '25.00', // Postgres numeric may serialize as string
          total_spend: '30.50',
          period: 'weekly',
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = null;
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toEqual({
      is_blocked: true,
      alert_id: 'alert-2',
      threshold_usd: 25.0,
      total_spend: 30.5,
      period: 'weekly',
    });
  });

  // --------------------------------------------------------------------------
  // RPC Errors
  // --------------------------------------------------------------------------

  it('returns null when RPC call fails', async () => {
    mockRpcResult = {
      data: null,
      error: { message: 'Function not found' },
    };

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = 'not-null';
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toBeNull();

    consoleSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Auth Check
  // --------------------------------------------------------------------------

  it('returns null when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = 'not-null';
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Zod Validation
  // --------------------------------------------------------------------------

  it('returns null when RPC response has invalid shape', async () => {
    mockRpcResult = {
      data: [
        {
          // Missing is_blocked field entirely
          alert_id: 'alert-1',
          threshold_usd: 10.0,
        },
      ],
      error: null,
    };

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = 'not-null';
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toBeNull();

    consoleSpy.mockRestore();
  });

  it('handles non-array RPC response (single object)', async () => {
    // Some Postgres RPCs return a single object instead of an array
    mockRpcResult = {
      data: {
        is_blocked: false,
        alert_id: null,
        threshold_usd: null,
        total_spend: null,
        period: null,
      },
      error: null,
    };

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let hardStopResult: unknown = null;
    await act(async () => {
      hardStopResult = await result.current.checkHardStop();
    });

    expect(hardStopResult).toEqual({
      is_blocked: false,
      alert_id: null,
      threshold_usd: null,
      total_spend: null,
      period: null,
    });
  });

  // --------------------------------------------------------------------------
  // Integration: RPC call uses correct parameters
  // --------------------------------------------------------------------------

  it('calls RPC with the authenticated user ID', async () => {
    mockRpcResult = { data: [], error: null };

    const { result } = renderHook(() => useBudgetAlerts());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.checkHardStop();
    });

    expect(supabase.rpc).toHaveBeenCalledWith('check_budget_hard_stop', {
      p_user_id: 'test-user-id',
    });
  });
});
