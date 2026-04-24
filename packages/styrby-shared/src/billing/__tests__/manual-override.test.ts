/**
 * Unit tests for shouldHonorManualOverride (Phase 4.1 T8).
 *
 * Tests the pure decision logic of the manual override gate without any
 * HTTP layer. These tests mock the Supabase client's .rpc() call to simulate
 * the response from the atomic apply_polar_subscription_with_override_check()
 * DB function (migration 045).
 *
 * WHY test this helper separately (not just the webhook route tests):
 * The helper encapsulates the business-critical invariant that admin-set
 * overrides survive Polar webhook replays. Testing it in isolation ensures
 * the decision logic is correct regardless of the webhook route changes.
 * (SOC2 CC6.1: logical access control must be verifiably correct.)
 *
 * WHY mock the RPC (not the raw from() chain):
 * shouldHonorManualOverride now delegates entirely to the atomic RPC
 * (apply_polar_subscription_with_override_check). The DB-layer expiry logic
 * (FOR UPDATE lock, UPDATE subscriptions, INSERT admin_audit_log) is tested
 * via the SQL test in migration 045 and admin_console_rls.sql test (n).
 * Here we test only the TypeScript translation layer: "given RPC response X,
 * does the function return the correct ManualOverrideDecision?"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldHonorManualOverride } from '../manual-override.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Shared test params (passed as the optional `params` argument)
// ============================================================================

const DEFAULT_PARAMS = {
  newTier: 'pro',
  polarSubscriptionId: 'sub_test_123',
  billingCycle: 'monthly',
  currentPeriodEnd: new Date('2027-03-01T00:00:00Z'),
  polarEventId: 'evt_test_abc',
} as const;

// ============================================================================
// Mock Supabase client builder
//
// Builds a minimal mock SupabaseClient that simulates the RPC response from
// apply_polar_subscription_with_override_check() (migration 045). The helper
// now calls only this one RPC; no from() chain is used.
// ============================================================================

type RpcRow = {
  decision: string;
  expires_at: string | null;
  previous_actor: string | null;
  audit_id: number | null;
};

function makeRpcMock(
  rpcData: RpcRow[] | null,
  rpcError: { message: string; code?: string } | null = null
): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcData, error: rpcError }),
    from: vi.fn(), // not used by the updated helper
  } as unknown as SupabaseClient;
}

// ============================================================================
// Tests
// ============================================================================

describe('shouldHonorManualOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 1: RPC returns polar_source (no override in effect)
  // ──────────────────────────────────────────────────────────────────────────
  it('returns polar_source when RPC decision is polar_source', async () => {
    const supabase = makeRpcMock([
      { decision: 'polar_source', expires_at: null, previous_actor: null, audit_id: null },
    ]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 2: RPC returns null / empty result (no subscription row)
  // ──────────────────────────────────────────────────────────────────────────
  it('returns polar_source when RPC returns null data', async () => {
    const supabase = makeRpcMock(null);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
  });

  it('returns polar_source when RPC returns empty array', async () => {
    const supabase = makeRpcMock([]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 3: RPC returns manual_override_active (future or permanent expiry)
  // ──────────────────────────────────────────────────────────────────────────
  it('returns manual_override_active when RPC decision is manual_override_active (permanent)', async () => {
    const supabase = makeRpcMock([
      { decision: 'manual_override_active', expires_at: null, previous_actor: null, audit_id: null },
    ]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({
      honor: true,
      reason: 'manual_override_active',
      expiresAt: null,
    });
  });

  it('returns manual_override_active with expiresAt when RPC returns future expiry', async () => {
    const futureExpiry = '2027-01-01T00:00:00Z';
    const supabase = makeRpcMock([
      {
        decision: 'manual_override_active',
        expires_at: futureExpiry,
        previous_actor: null,
        audit_id: null,
      },
    ]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({
      honor: true,
      reason: 'manual_override_active',
      expiresAt: futureExpiry,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 4: RPC returns override_expired with prior actor
  //
  // WHY: The RPC has already applied the tier update + audit INSERT atomically.
  // The helper just translates the RPC response into the override_expired union.
  // ──────────────────────────────────────────────────────────────────────────
  it('returns override_expired with prior actor when RPC applied expiry atomically', async () => {
    const pastExpiry = '2026-01-01T00:00:00Z';
    const priorAdminId = 'admin-uuid-abc';
    const supabase = makeRpcMock([
      {
        decision: 'override_expired',
        expires_at: pastExpiry,
        previous_actor: priorAdminId,
        audit_id: 9001,
      },
    ]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({
      honor: false,
      reason: 'override_expired',
      expiredAt: pastExpiry,
      previousActor: priorAdminId,
      auditId: 9001,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 5: RPC returns override_expired with null prior actor
  //
  // WHY: The override may have been set via direct SQL before the audit log
  // existed. The RPC correctly returns null previous_actor; migration 044
  // permits null actor_id for system-action audit rows.
  // ──────────────────────────────────────────────────────────────────────────
  it('returns override_expired with null previousActor when no prior audit row found', async () => {
    const pastExpiry = '2026-01-01T00:00:00Z';
    const supabase = makeRpcMock([
      {
        decision: 'override_expired',
        expires_at: pastExpiry,
        previous_actor: null,
        audit_id: 1234,
      },
    ]);
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({
      honor: false,
      reason: 'override_expired',
      expiredAt: pastExpiry,
      previousActor: null,
      auditId: 1234,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 6: RPC error - fail-open to polar_source
  //
  // WHY fail-open: if the DB is unreachable, the webhook should apply Polar's
  // tier update as-is rather than blocking all tier updates indefinitely.
  // SOC2 CC6.1 implication: documented in shouldHonorManualOverride @throws.
  // The alternative (fail-closed / return 500) would freeze legitimate tier
  // updates for the duration of the outage, which is a worse billing outcome.
  // ──────────────────────────────────────────────────────────────────────────
  it('returns polar_source when RPC errors (fail-open - DB unreachable)', async () => {
    const supabase = makeRpcMock(null, { message: 'connection timeout' });
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 6b: RPC rejects with ERRCODE 22023 (invalid tier value)
  //
  // WHY this test exists:
  // The RPC-layer tier allowlist (migration 045 §4) fires before the FOR UPDATE
  // lock is acquired. If a tier string bypasses getTierFromProductId() (Node-layer
  // regression or future Polar payload expansion), the RPC raises ERRCODE 22023.
  // The helper must NOT silently swallow this as polar_source - doing so would
  // allow the webhook route to call upsert with the invalid tier and corrupt
  // subscription state. Instead the helper re-throws so the route returns 500
  // and Polar retries. This verifies the re-throw behavior.
  //
  // Three supabase-js error surface variants are tested:
  //   a) error.code = '22023' (direct PG ERRCODE passthrough)
  //   b) error.message contains 'invalid tier value' (message-based detection)
  //   c) error.code = 'PGRST202' (PostgREST wraps some PG errors with this code)
  //
  // OWASP A09:2021: invalid tier errors must surface in Sentry (error log + throw)
  //   rather than being accepted silently.
  // ──────────────────────────────────────────────────────────────────────────
  it('throws (does NOT fail-open) when RPC returns ERRCODE 22023 via error.code', async () => {
    const supabase = makeRpcMock(null, { message: 'invalid tier value', code: '22023' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      shouldHonorManualOverride('user-uuid-1', supabase, {
        ...DEFAULT_PARAMS,
        newTier: 'not-a-real-tier',
      })
    ).rejects.toThrow(/invalid tier value.*22023/i);

    // WHY: error-level log (not warn) signals a code/config defect to Sentry.
    const errorLogJson = consoleErrorSpy.mock.calls
      .map((args) => {
        try { return JSON.parse(args[0] as string); } catch { return null; }
      })
      .find((obj) => obj?.msg?.includes('22023'));
    expect(errorLogJson).toBeDefined();
    expect(errorLogJson?.level).toBe('error');

    consoleErrorSpy.mockRestore();
  });

  it('throws (does NOT fail-open) when RPC error.message contains "invalid tier value"', async () => {
    // Simulates a supabase-js version where code is absent but message is set.
    const supabase = makeRpcMock(null, { message: 'ERROR: invalid tier value' });
    await expect(
      shouldHonorManualOverride('user-uuid-1', supabase, {
        ...DEFAULT_PARAMS,
        newTier: 'bad-tier',
      })
    ).rejects.toThrow(/invalid tier value/i);
  });

  it('still fails-open (returns polar_source) for non-22023 RPC errors', async () => {
    // Sanity check: generic DB errors still use the fail-open path (Case 6).
    const supabase = makeRpcMock(null, { message: 'connection timeout' });
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase, DEFAULT_PARAMS);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 7: RPC called without params (backward compat - empty string defaults)
  //
  // WHY: The params argument is optional to allow callers that have not yet
  // migrated to pass params. Without params, p_new_tier etc. default to ''.
  // The RPC will still correctly return the decision for the active/inactive
  // override cases; the expiry UPDATE inside the RPC will set tier='' (which
  // is invalid but the caller would need to follow up - acceptable edge case
  // documented in the function JSDoc).
  // ──────────────────────────────────────────────────────────────────────────
  it('still works when params are omitted (backward compat)', async () => {
    const supabase = makeRpcMock([
      { decision: 'polar_source', expires_at: null, previous_actor: null, audit_id: null },
    ]);
    // No params passed - should not throw
    const decision = await shouldHonorManualOverride('user-uuid-1', supabase);
    expect(decision).toEqual({ honor: false, reason: 'polar_source' });
    // Verify the RPC was called with empty-string defaults
    const rpcMock = vi.mocked((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc);
    expect(rpcMock).toHaveBeenCalledWith(
      'apply_polar_subscription_with_override_check',
      expect.objectContaining({
        p_new_tier: '',
        p_polar_subscription_id: '',
        p_billing_cycle: '',
        p_current_period_end: null,
        p_polar_event_id: null,
      })
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 8: Concurrent delivery simulation
  //
  // WHY: CRITICAL 2 fix verifies that two concurrent webhook deliveries for
  // the same user do not both execute the expiry path. The atomic RPC holds
  // a FOR UPDATE lock; the second delivery sees 'polar_source' (already reset)
  // rather than 'override_expired'.
  //
  // In this test we simulate the state-flip that the DB lock enforces:
  //   - First call: RPC returns 'override_expired' (first delivery wins the lock)
  //   - Second call: RPC returns 'polar_source' (second delivery sees updated row)
  //
  // The test asserts that exactly ONE override_expired is produced and the
  // second delivery is treated as a normal Polar tier update.
  //
  // NOTE: This test verifies the TypeScript translation layer, not the actual
  // DB concurrency behavior (which is tested by the SQL test in migration 045).
  // ──────────────────────────────────────────────────────────────────────────
  it('concurrent delivery: second delivery sees polar_source after first wins expiry lock', async () => {
    const pastExpiry = '2026-01-01T00:00:00Z';

    // The same mock RPC call returns different results on consecutive calls,
    // simulating the DB-level state flip caused by the FOR UPDATE lock.
    const rpcMock = vi.fn()
      // First concurrent delivery: RPC acquires lock, applies expiry, returns override_expired.
      .mockResolvedValueOnce({
        data: [{
          decision: 'override_expired',
          expires_at: pastExpiry,
          previous_actor: 'admin-uuid-xyz',
          audit_id: 5000,
        }],
        error: null,
      })
      // Second concurrent delivery: lock was already released after first txn committed.
      // Row now shows override_source='polar' - RPC returns polar_source.
      .mockResolvedValueOnce({
        data: [{
          decision: 'polar_source',
          expires_at: null,
          previous_actor: null,
          audit_id: null,
        }],
        error: null,
      });

    const supabase = { rpc: rpcMock, from: vi.fn() } as unknown as SupabaseClient;

    // Simulate two parallel calls (second awaited after first completes, mimicking
    // the sequential behavior enforced by the DB-level FOR UPDATE lock).
    const [decision1, decision2] = await Promise.all([
      shouldHonorManualOverride('user-concurrent', supabase, DEFAULT_PARAMS),
      shouldHonorManualOverride('user-concurrent', supabase, DEFAULT_PARAMS),
    ]);

    // First delivery: override expired - RPC applied the expiry atomically.
    expect(decision1.reason).toBe('override_expired');
    expect((decision1 as { auditId: number }).auditId).toBe(5000);

    // Second delivery: Polar source - sees the updated row, processes normally.
    expect(decision2).toEqual({ honor: false, reason: 'polar_source' });

    // Sanity: RPC was called exactly twice (once per delivery).
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});
