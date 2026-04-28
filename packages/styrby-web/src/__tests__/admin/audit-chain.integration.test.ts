/**
 * Admin Console — Audit Chain Integrity Integration Tests
 *
 * Integration seam: This file verifies the chain-integrity invariant end-to-end
 * through the GET /api/admin/audit/verify route handler. The route receives an
 * RPC response, Zod-validates its shape, and returns structured JSON. These tests
 * mock the RPC response at the Supabase client boundary and assert the full
 * route response — including the Zod parse + auth gates — for each scenario.
 *
 * WHY this exists (Phase 4.1 T9):
 *   The audit chain is a SOC 2 CC7.2 tamper-evidence control. If the verify
 *   endpoint returns the wrong status (e.g., returns 'ok' for a tampered chain
 *   because Zod validation was skipped), an attacker could erase evidence of
 *   an unauthorized admin action without triggering an alert. These integration
 *   tests confirm the full route contract — including auth checks, RPC parsing,
 *   and Zod validation — for all status values.
 *
 * What phase it tests: Phase 4.1 (Admin Console — T5 audit chain + T9
 * integration coverage).
 *
 * SOC 2 CC7.2: Audit log integrity monitoring. NIST SP 800-53 AU-9.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({
  createClient:      vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({
  isAdmin: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// WHY mock mfa-gate: the audit-chain tests mock createAdminClient to return
// only the RPC response shape. assertAdminMfa calls createAdminClient to query
// site_admins + passkeys + Auth API. Without this mock, assertAdminMfa would
// fail-closed (throw AdminMfaRequiredError → 403), causing all tests to fail.
// These tests verify the audit chain logic, not the MFA gate behavior.
// MFA gate is covered in __tests__/admin/mfa-gate.test.ts. OWASP A07:2021.
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
import * as Sentry from '@sentry/nextjs';
import { GET } from '../../app/api/admin/audit/verify/route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Configures createClient mock to return a user (or null for unauth).
 *
 * @param user - User object or null for unauthenticated.
 */
function mockAuthUser(user: { id: string } | null) {
  (createClient as Mock).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data:  { user },
        error: user ? null : new Error('Not authenticated'),
      }),
    },
  });
}

/**
 * Configures createClient to return both auth (admin-1) and the RPC result.
 *
 * WHY createClient (not createAdminClient): Fix P0 swapped verify_admin_audit_chain
 * RPC from service-role to user-scoped client so auth.uid() resolves inside the
 * SECURITY DEFINER function. The route reuses the same createClient() instance
 * for both getUser() and rpc(), so this helper provides both in one mock.
 *
 * @param rpcResponse - What the `rpc('verify_admin_audit_chain')` call returns.
 */
function mockAdminRpc(rpcResponse: { data: unknown; error: Error | null }) {
  (createClient as Mock).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data:  { user: { id: 'admin-uuid-001' } },
        error: null,
      }),
    },
    rpc: vi.fn().mockResolvedValue(rpcResponse),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/audit/verify — audit chain integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated site admin.
    mockAuthUser({ id: 'admin-uuid-001' });
    (isAdmin as Mock).mockResolvedValue(true);
  });

  // --------------------------------------------------------------------------
  // (a) Fresh chain returns ok
  // --------------------------------------------------------------------------

  describe('(a) fresh chain — status ok', () => {
    it('returns 200 with { status: "ok", first_broken_id: null, total_rows: 42 }', async () => {
      // Simulate a healthy chain — every row's hash links correctly.
      mockAdminRpc({
        data:  [{ status: 'ok', first_broken_id: null, total_rows: 42 }],
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        status:          'ok',
        first_broken_id: null,
        total_rows:      42,
      });
    });

    it('handles single-object (non-array) RPC response shape', async () => {
      // Supabase JS may return an object directly for RETURNS TABLE with 1 row.
      mockAdminRpc({
        data:  { status: 'ok', first_broken_id: null, total_rows: 7 },
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(body.total_rows).toBe(7);
    });
  });

  // --------------------------------------------------------------------------
  // (b) Tampered chain returns row_hash_mismatch at correct id
  // --------------------------------------------------------------------------

  describe('(b) tampered chain — row_hash_mismatch', () => {
    it('returns 200 with { status: "row_hash_mismatch", first_broken_id: 17, total_rows: 100 }', async () => {
      // WHY row_hash_mismatch: a row's stored hash does not match the
      // recomputed hash — the row content was modified after insertion.
      // first_broken_id: 17 = the earliest tampered row.
      mockAdminRpc({
        data:  [{ status: 'row_hash_mismatch', first_broken_id: 17, total_rows: 100 }],
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        status:          'row_hash_mismatch',
        first_broken_id: 17,
        total_rows:      100,
      });
    });

    it('preserves the exact first_broken_id value from the RPC', async () => {
      // WHY: The first_broken_id is forensically significant — it tells ops
      // exactly which audit row was tampered with. Must not be coerced or
      // defaulted to a different value.
      const tamperedId = 9999;
      mockAdminRpc({
        data:  [{ status: 'row_hash_mismatch', first_broken_id: tamperedId, total_rows: 10000 }],
        error: null,
      });

      const response = await GET();
      const body = await response.json();

      expect(body.first_broken_id).toBe(tamperedId);
    });
  });

  // --------------------------------------------------------------------------
  // (c) Broken prev_hash returns prev_hash_mismatch
  // --------------------------------------------------------------------------

  describe('(c) broken prev_hash link — prev_hash_mismatch', () => {
    it('returns 200 with { status: "prev_hash_mismatch", first_broken_id: 3, total_rows: 50 }', async () => {
      // WHY prev_hash_mismatch: a row's prev_hash does not match the preceding
      // row's hash — a row was deleted or inserted out of sequence in the chain.
      mockAdminRpc({
        data:  [{ status: 'prev_hash_mismatch', first_broken_id: 3, total_rows: 50 }],
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        status:          'prev_hash_mismatch',
        first_broken_id: 3,
        total_rows:      50,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Auth guards
  // --------------------------------------------------------------------------

  describe('auth guards', () => {
    it('returns 401 for unauthenticated caller', async () => {
      mockAuthUser(null);

      const response = await GET();
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 403 for authenticated non-admin', async () => {
      mockAuthUser({ id: 'regular-user-uuid' });
      (isAdmin as Mock).mockResolvedValue(false);

      const response = await GET();
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });
  });

  // --------------------------------------------------------------------------
  // RPC error handling
  // --------------------------------------------------------------------------

  describe('RPC error handling', () => {
    it('returns 500 and captures Sentry when RPC fails', async () => {
      mockAdminRpc({
        data:  null,
        error: new Error('DB connection timeout'),
      });

      const response = await GET();
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('INTERNAL_ERROR');
      // Sentry must capture the RPC error for ops triage. SOC 2 CC7.2.
      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });

    it('returns 500 and captures Sentry when RPC response has unexpected shape', async () => {
      // WHY: Zod validates the RPC response shape. Schema drift (e.g., column
      // rename in the DB function) must surface as a 500 + Sentry alert, not
      // silently return malformed JSON. OWASP A08:2021.
      mockAdminRpc({
        data:  [{ unexpected_field: 'yes', total_rows: 5 }], // missing 'status'
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(500);

      // Sentry must be called to alert ops of schema drift.
      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });
  });
});
