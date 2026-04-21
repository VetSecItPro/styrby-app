/**
 * Tests for useMonthlySpend.
 *
 * WHY: This hook hits cost_records and aggregates spend for the subscription
 * usage bar. Regressions here either (a) double-count across months when the
 * UTC boundary math is off, or (b) silently return 0 when the Supabase
 * response shape changes. Both would mislead paying users about their
 * current-month burn, which is a trust-breaker.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMonthlySpend } from '../use-monthly-spend';

type FakeRow = { cost_usd: number | string | null };

/**
 * Build a minimal Supabase-client stub that records the call chain so the
 * tests can assert BOTH the filter timestamp and the returned total.
 */
function makeSupabase(rows: FakeRow[] | null) {
  const gte = vi.fn().mockResolvedValue({ data: rows, error: null });
  const select = vi.fn().mockReturnValue({ gte });
  const from = vi.fn().mockReturnValue({ select });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, gte, select, from };
}

describe('useMonthlySpend', () => {
  it('returns null and does not query when disabled', () => {
    const { client, from } = makeSupabase([]);
    const { result } = renderHook(() => useMonthlySpend(client, false));
    expect(result.current).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('sums numeric cost_usd values from cost_records', async () => {
    const { client } = makeSupabase([
      { cost_usd: 1.5 },
      { cost_usd: 2.25 },
      { cost_usd: 0.25 },
    ]);
    const { result } = renderHook(() => useMonthlySpend(client, true));
    await waitFor(() => expect(result.current).toBe(4));
  });

  it('coerces string cost_usd values and ignores nulls', async () => {
    const { client } = makeSupabase([
      { cost_usd: '2.50' },
      { cost_usd: null },
      { cost_usd: '1.00' },
    ]);
    const { result } = renderHook(() => useMonthlySpend(client, true));
    await waitFor(() => expect(result.current).toBe(3.5));
  });

  it('returns 0 when cost_records returns no rows', async () => {
    const { client } = makeSupabase([]);
    const { result } = renderHook(() => useMonthlySpend(client, true));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('treats null data as empty', async () => {
    const { client } = makeSupabase(null);
    const { result } = renderHook(() => useMonthlySpend(client, true));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('filters by the first-of-month UTC boundary', async () => {
    const { client, gte } = makeSupabase([]);
    renderHook(() => useMonthlySpend(client, true));
    await waitFor(() => expect(gte).toHaveBeenCalled());
    const [col, boundary] = gte.mock.calls[0];
    expect(col).toBe('recorded_at');
    const d = new Date(boundary as string);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });
});
