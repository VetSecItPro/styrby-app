/**
 * Tests for the seat-cap validator.
 *
 * TDD: These tests were written BEFORE the implementation.
 *
 * Coverage:
 *   - below-cap: returns ok=true
 *   - at-cap: returns ok=false with upgrade CTA
 *   - null-cap (unlimited): returns ok=true with nullCap warning
 *   - zero seats used: returns ok=true
 *   - exactly one seat below cap: returns ok=true
 *   - advisory lock: documented behavior (cannot unit-test Postgres lock,
 *     tested at integration level in Unit B)
 *
 * @module team/__tests__/seat-cap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSeatCap, type SeatCapResult } from '../seat-cap.js';

// ============================================================================
// Mock Supabase client
// ============================================================================

/**
 * Creates a minimal Supabase client mock for seat-cap tests.
 *
 * WHY: We cannot hit a real Supabase instance in unit tests. The mock
 * captures the `.from('teams').select(...).eq(...).single()` chain and
 * returns configurable data. This verifies our query shape without I/O.
 *
 * @param row - The row to return from the mock `teams` query
 */
function makeSupabaseMock(row: { seat_cap: number | null; active_seats: number } | null, error?: { message: string }) {
  const single = vi.fn().mockResolvedValue({ data: row, error: error ?? null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from } as unknown as Parameters<typeof validateSeatCap>[1];
}

const TEAM_ID = '00000000-0000-0000-0000-000000000001';

// ============================================================================
// Tests
// ============================================================================

describe('validateSeatCap', () => {
  it('returns ok=true when active_seats < seat_cap', async () => {
    const client = makeSupabaseMock({ seat_cap: 5, active_seats: 3 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(true);
    expect(result.currentSeats).toBe(3);
    expect(result.seatCap).toBe(5);
    expect(result.overageInfo).toBeUndefined();
    expect(result.nullCapWarning).toBeUndefined();
  });

  it('returns ok=true when active_seats is 0 (empty team)', async () => {
    const client = makeSupabaseMock({ seat_cap: 3, active_seats: 0 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(true);
    expect(result.currentSeats).toBe(0);
  });

  it('returns ok=true when exactly one seat below cap', async () => {
    const client = makeSupabaseMock({ seat_cap: 4, active_seats: 3 });
    const result = await validateSeatCap(TEAM_ID, client);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with overage info when active_seats >= seat_cap', async () => {
    const client = makeSupabaseMock({ seat_cap: 3, active_seats: 3 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(false);
    expect(result.currentSeats).toBe(3);
    expect(result.seatCap).toBe(3);
    expect(result.overageInfo).toBeDefined();
    expect(result.overageInfo!.upgradeCta).toContain(TEAM_ID);
    expect(result.overageInfo!.upgradeCta).toContain('/billing/add-seat');
  });

  it('returns ok=false when active_seats exceeds seat_cap', async () => {
    const client = makeSupabaseMock({ seat_cap: 3, active_seats: 5 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(false);
    expect(result.overageInfo).toBeDefined();
  });

  it('returns ok=true with nullCapWarning when seat_cap is NULL (unlimited)', async () => {
    const client = makeSupabaseMock({ seat_cap: null, active_seats: 10 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(true);
    expect(result.seatCap).toBeNull();
    expect(result.currentSeats).toBe(10);
    expect(result.nullCapWarning).toBe(true);
    expect(result.overageInfo).toBeUndefined();
  });

  it('throws when the Supabase query returns an error', async () => {
    const client = makeSupabaseMock(null, { message: 'connection refused' });
    await expect(validateSeatCap(TEAM_ID, client)).rejects.toThrow('connection refused');
  });

  it('throws when the team row is not found', async () => {
    const client = makeSupabaseMock(null);
    await expect(validateSeatCap(TEAM_ID, client)).rejects.toThrow();
  });

  it('includes upgrade CTA with correct team param', async () => {
    const specificTeam = '00000000-0000-0000-0000-000000000099';
    const client = makeSupabaseMock({ seat_cap: 1, active_seats: 1 });
    const result = await validateSeatCap(specificTeam, client);

    expect(result.ok).toBe(false);
    expect(result.overageInfo!.upgradeCta).toBe(`/billing/add-seat?team=${specificTeam}`);
  });

  it('returns ok=false when cap is reached by combined members + pending invites', async () => {
    // WHY: active_seats now includes pending invitations (per spec). A team with
    // 4 members + 1 pending invite has active_seats=5. If seat_cap=5, the cap
    // is reached and no further invites should be allowed.
    // The trigger fn_team_invitations_seat_delta maintains this total, so the
    // edge function reads a single active_seats value that already reflects both.
    const client = makeSupabaseMock({ seat_cap: 5, active_seats: 5 });
    const result = await validateSeatCap(TEAM_ID, client);

    expect(result.ok).toBe(false);
    expect(result.currentSeats).toBe(5);
    expect(result.seatCap).toBe(5);
    expect(result.overageInfo).toBeDefined();
    expect(result.overageInfo!.upgradeCta).toContain(TEAM_ID);
  });
});
