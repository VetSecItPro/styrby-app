/**
 * Tests for useSubscriptionTier hook.
 *
 * WHY: Subscription tier gates several features (smart notifications, export,
 * metrics). A wrong tier default or failure to handle missing rows could
 * silently unlock or block features incorrectly.
 *
 * @module hooks/__tests__/useSubscriptionTier
 */

// ============================================================================
// Module mocks
// ============================================================================

const mockFrom = jest.fn();
jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useSubscriptionTier } from '../useSubscriptionTier';

// ============================================================================
// Helpers
// ============================================================================

function mockSupabaseTier(plan: string | null, error: unknown = null) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: plan !== null ? { plan } : null,
      error,
    }),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

// ============================================================================
// Tests
// ============================================================================

describe('useSubscriptionTier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns free tier and no loading when userId is null', () => {
    const { result } = renderHook(() => useSubscriptionTier(null));

    expect(result.current.tier).toBe('free');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPaid).toBe(false);
  });

  it('returns free tier when no subscription row exists', async () => {
    mockSupabaseTier(null);

    const { result } = renderHook(() => useSubscriptionTier('user-1'));
    await act(async () => {});

    expect(result.current.tier).toBe('free');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPaid).toBe(false);
  });

  it('returns power tier when subscription row has plan=power', async () => {
    mockSupabaseTier('power');

    const { result } = renderHook(() => useSubscriptionTier('user-1'));
    await act(async () => {});

    expect(result.current.tier).toBe('power');
    expect(result.current.isPaid).toBe(true);
  });

  it('returns pro tier when subscription row has plan=pro', async () => {
    mockSupabaseTier('pro');

    const { result } = renderHook(() => useSubscriptionTier('user-1'));
    await act(async () => {});

    expect(result.current.tier).toBe('pro');
    expect(result.current.isPaid).toBe(true);
  });

  it('sets error and defaults to free on Supabase error', async () => {
    mockSupabaseTier(null, { message: 'permission denied', code: '42501' });

    const { result } = renderHook(() => useSubscriptionTier('user-1'));
    await act(async () => {});

    expect(result.current.tier).toBe('free');
    expect(result.current.error).not.toBeNull();
  });

  it('starts with isLoading true when userId is provided', () => {
    // Never-resolving promise to capture initial state
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn<unknown, unknown[]>(() => new Promise(() => {})),
    };
    mockFrom.mockReturnValue(chain);

    const { result } = renderHook(() => useSubscriptionTier('user-1'));

    expect(result.current.isLoading).toBe(true);
  });

  it('re-fetches when userId changes', async () => {
    mockSupabaseTier('free');

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | null }) => useSubscriptionTier(userId),
      { initialProps: { userId: 'user-1' } },
    );

    await act(async () => {});
    expect(mockFrom).toHaveBeenCalledTimes(1);

    mockSupabaseTier('power');

    await act(async () => {
      rerender({ userId: 'user-2' });
    });

    expect(mockFrom).toHaveBeenCalledTimes(2);
    expect(result.current.tier).toBe('power');
  });
});
