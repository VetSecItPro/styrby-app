/**
 * Tests for GET /api/admin/audit/verify
 *
 * Covers:
 *   (a) PASS: returns { status: 'ok', ... } when RPC returns ok
 *   (b) FAIL: returns { status: 'row_hash_mismatch', first_broken_id: 42, total_rows: 100 }
 *   (c) RPC error: returns 500 + Sentry capture
 *   (d) Unauthenticated: returns 401
 *   (e) Non-admin: returns 403
 *
 * WHY these test targets:
 *   The verify endpoint enforces two critical access controls. Regressions in
 *   either would expose audit chain status (a tamper-evidence indicator) to
 *   unauthorized users, or silently swallow RPC failures that indicate a
 *   security-relevant DB incident. SOC 2 CC7.2.
 *
 * Testing strategy:
 *   Mock Supabase, isAdmin, and Sentry at the module boundary to isolate
 *   the route handler logic from infrastructure dependencies.
 *
 * @module api/admin/audit/verify/__tests__/route
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({
  isAdmin: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// WHY mock mfa-gate (H42 Layer 1): the route calls assertAdminMfa(user.id) after
// the isAdmin check. Without this mock the real gate tries to query the DB via
// createAdminClient which has no passkeys table in the test environment. Mocking
// at the public contract level keeps the unit test focused on route logic while
// the MFA gate's own behaviour is covered by src/lib/admin/__tests__/mfa-gate.test.ts.
// OWASP A07:2021, SOC 2 CC6.1.
vi.mock('@/lib/admin/mfa-gate', () => ({
  assertAdminMfa: vi.fn().mockResolvedValue(undefined),
  AdminMfaRequiredError: class AdminMfaRequiredError extends Error {
    statusCode = 403 as const;
    code = 'ADMIN_MFA_REQUIRED' as const;
    constructor() {
      super('Admin MFA required');
      this.name = 'AdminMfaRequiredError';
    }
  },
}));

import { createClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
import * as Sentry from '@sentry/nextjs';
import { GET } from '../route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Configures the createClient mock to return a Supabase client with an
 * authenticated user (or null for unauthenticated).
 *
 * @param user - User object ({ id }) or null for unauthenticated
 */
function mockSupabaseUser(user: { id: string } | null) {
  (createClient as Mock).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: user ? null : new Error('Not authenticated'),
      }),
    },
  });
}

/**
 * Configures the createClient mock to also return an RPC result.
 *
 * WHY createClient (not createAdminClient): Fix P0 swapped the verify_admin_audit_chain
 * RPC call from service-role to user-scoped so auth.uid() resolves inside the
 * SECURITY DEFINER function. The mock must reflect the production code path.
 *
 * @param data  - Data returned by the RPC (or null on error)
 * @param error - Error returned by the RPC (or null on success)
 */
function mockRpc(
  data: Record<string, unknown> | null,
  error: { message: string } | null = null
) {
  // The route reuses the same createClient() instance for both getUser() and
  // rpc(). We chain both mock behaviors on the same resolved client object.
  (createClient as Mock).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'admin-1' } },
        error: null,
      }),
    },
    rpc: vi.fn().mockResolvedValue({ data, error }),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/admin/audit/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Auth gate ──────────────────────────────────────────────────────────────

  it('(d) returns 401 when user is not authenticated', async () => {
    mockSupabaseUser(null);
    (isAdmin as Mock).mockResolvedValue(false);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('(e) returns 403 when user is authenticated but not admin', async () => {
    mockSupabaseUser({ id: 'user-123' });
    (isAdmin as Mock).mockResolvedValue(false);

    const res = await GET();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('does not call RPC for non-admins (admin gate enforced before DB access)', async () => {
    const mockRpcFn = vi.fn();
    (createClient as Mock).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'attacker' } },
          error: null,
        }),
      },
      rpc: mockRpcFn,
    });
    (isAdmin as Mock).mockResolvedValue(false);

    await GET();

    // WHY: the RPC must never be called before the admin gate passes.
    // Fix P0: route now uses user-scoped client for RPC, so we assert the RPC
    // function itself was not invoked rather than asserting createAdminClient
    // was not called. SOC 2 CC6.1: DB access guarded behind authorization.
    expect(mockRpcFn).not.toHaveBeenCalled();
  });

  // ── PASS path ──────────────────────────────────────────────────────────────

  it('(a) returns 200 with { status: "ok" } when RPC returns ok', async () => {
    // mockRpc sets up createClient with both auth (user admin-1) and rpc result.
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ status: 'ok', first_broken_id: null, total_rows: 150 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.first_broken_id).toBeNull();
    expect(body.total_rows).toBe(150);
  });

  // ── FAIL paths ─────────────────────────────────────────────────────────────

  it('(b) returns 200 with row_hash_mismatch when RPC detects row tampering', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ status: 'row_hash_mismatch', first_broken_id: 42, total_rows: 100 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('row_hash_mismatch');
    expect(body.first_broken_id).toBe(42);
    expect(body.total_rows).toBe(100);
  });

  it('returns 200 with prev_hash_mismatch when RPC detects chain link deletion', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ status: 'prev_hash_mismatch', first_broken_id: 77, total_rows: 200 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('prev_hash_mismatch');
    expect(body.first_broken_id).toBe(77);
  });

  // ── RPC error path ─────────────────────────────────────────────────────────

  it('(c) returns 500 when RPC errors', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc(null, { message: 'function verify_admin_audit_chain does not exist' });

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  it('(c) captures RPC errors to Sentry', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    const rpcError = { message: 'DB error' };
    mockRpc(null, rpcError);

    await GET();

    // WHY verify Sentry capture: RPC errors on this endpoint indicate DB schema
    // drift or a serious infrastructure issue. Ops must be alerted immediately.
    // SOC 2 CC7.2: audit integrity failures are ops-critical events.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      rpcError,
      expect.objectContaining({ tags: { endpoint: 'audit-verify' } })
    );
  });

  it('(c) does not capture Sentry on successful verification', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ status: 'ok', first_broken_id: null, total_rows: 50 });

    await GET();

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── Zod schema validation ──────────────────────────────────────────────────

  it('returns 200 when RPC returns array shape (RETURNS TABLE from Supabase JS)', async () => {
    // WHY: verify_admin_audit_chain is declared RETURNS TABLE — Supabase JS wraps
    // the result in an array with one element. The route must handle this shape.
    // Fix P0: route now uses user-scoped createClient for RPC, so mock it here.
    (isAdmin as Mock).mockResolvedValue(true);
    (createClient as Mock).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'admin-1' } },
          error: null,
        }),
      },
      // Simulate the array-wrapped TABLE return
      rpc: vi.fn().mockResolvedValue({
        data: [{ status: 'ok', first_broken_id: null, total_rows: 77 }],
        error: null,
      }),
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.total_rows).toBe(77);
  });

  it('returns 500 and captures Sentry when RPC returns unexpected schema (schema drift)', async () => {
    // WHY: If the Postgres function changes shape (e.g., renames a column),
    // Zod parse fails and we return 500 + Sentry alert instead of bad JSON.
    // OWASP A08:2021: Software and Data Integrity Failures.
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ unexpected_field: 'schema_drift', some_other: 123 });

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal error');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'audit-verify: unexpected RPC shape' }),
      expect.objectContaining({
        tags: expect.objectContaining({ schema_drift: 'true' }),
      }),
    );
  });

  // ── (MFA gate) H42 Layer 1 wiring proof ─────────────────────────────────────
  // WHY: proves the route calls assertAdminMfa and short-circuits to 403 when
  // the gate throws AdminMfaRequiredError — the RPC must never run on gate failure.
  // OWASP A07:2021, SOC 2 CC6.1.
  it('(MFA gate) returns 403 ADMIN_MFA_REQUIRED and skips RPC when assertAdminMfa throws', async () => {
    (isAdmin as Mock).mockResolvedValue(true);
    mockSupabaseUser({ id: 'admin-1' });
    (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const res = await GET();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('ADMIN_MFA_REQUIRED');
    // RPC must not be called when MFA gate fires.
    // (createClient mock's rpc is not set up in this test path — if the RPC
    // were called, it would throw, causing a 500 rather than the expected 403.)
  });
});
