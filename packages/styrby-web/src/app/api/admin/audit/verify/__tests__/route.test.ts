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

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
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
 * Configures the createAdminClient mock to return an RPC result.
 *
 * @param data  - Data returned by the RPC (or null on error)
 * @param error - Error returned by the RPC (or null on success)
 */
function mockRpc(
  data: Record<string, unknown> | null,
  error: { message: string } | null = null
) {
  (createAdminClient as Mock).mockReturnValue({
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

  it('does not call createAdminClient for non-admins', async () => {
    mockSupabaseUser({ id: 'attacker' });
    (isAdmin as Mock).mockResolvedValue(false);

    await GET();

    // WHY: service-role DB access must never occur before the admin gate passes.
    // SOC 2 CC6.1: admin client used only after authorization confirmed.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // ── PASS path ──────────────────────────────────────────────────────────────

  it('(a) returns 200 with { status: "ok" } when RPC returns ok', async () => {
    mockSupabaseUser({ id: 'admin-1' });
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
    mockSupabaseUser({ id: 'admin-1' });
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
    mockSupabaseUser({ id: 'admin-1' });
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
    mockSupabaseUser({ id: 'admin-1' });
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc(null, { message: 'function verify_admin_audit_chain does not exist' });

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  it('(c) captures RPC errors to Sentry', async () => {
    mockSupabaseUser({ id: 'admin-1' });
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
    mockSupabaseUser({ id: 'admin-1' });
    (isAdmin as Mock).mockResolvedValue(true);
    mockRpc({ status: 'ok', first_broken_id: null, total_rows: 50 });

    await GET();

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── Zod schema validation ──────────────────────────────────────────────────

  it('returns 200 when RPC returns array shape (RETURNS TABLE from Supabase JS)', async () => {
    // WHY: verify_admin_audit_chain is declared RETURNS TABLE — Supabase JS wraps
    // the result in an array with one element. The route must handle this shape.
    mockSupabaseUser({ id: 'admin-1' });
    (isAdmin as Mock).mockResolvedValue(true);
    // Simulate the array-wrapped TABLE return
    (createAdminClient as Mock).mockReturnValue({
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
    mockSupabaseUser({ id: 'admin-1' });
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
});
