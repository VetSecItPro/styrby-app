/**
 * Tests for the admin authorization utility.
 *
 * Phase 4.1 T3.5 cutover (PR #154): isAdmin() now calls the `is_site_admin`
 * Postgres function via RPC instead of querying `profiles.is_admin` directly.
 * Tests updated to mock `.rpc('is_site_admin', ...)` accordingly.
 *
 * WHY these tests matter: isAdmin() is the sole gate protecting every admin
 * endpoint. If it returns true for a non-admin user — due to a bug in the
 * RPC call, null handling, or type coercion — any authenticated user becomes
 * an admin. These tests verify every trust boundary.
 *
 * Covers:
 * - Returns true only when is_site_admin() RPC returns true
 * - Returns false when RPC returns false
 * - Returns false when RPC returns null/undefined
 * - Returns false immediately for empty/falsy userId (no DB query needed)
 * - Database RPC errors do not grant admin access (fail-closed)
 * - Uses createAdminClient() (not user-scoped client)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockRpc = vi.fn();
const mockCreateAdminClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: mockCreateAdminClient,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a Supabase client stub whose `.rpc()` method resolves to the given
 * result. Mirrors the pattern used by the real Supabase client.
 *
 * @param data  - Value returned from the RPC call (true/false/null)
 * @param error - Optional error to simulate a failed RPC call
 */
function buildRpcClient(
  data: boolean | null | undefined,
  error: { message: string } | null = null
) {
  mockRpc.mockResolvedValue({ data, error });
  mockCreateAdminClient.mockReturnValue({ rpc: mockRpc });
}

// ============================================================================
// Tests
// ============================================================================

describe('isAdmin()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Short-circuit: invalid userId
  // --------------------------------------------------------------------------

  describe('invalid userId — never queries the database', () => {
    it('returns false for an empty string without hitting Supabase', async () => {
      const { isAdmin } = await import('../admin');
      const result = await isAdmin('');

      expect(result).toBe(false);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Admin: is_site_admin() returns true
  // --------------------------------------------------------------------------

  describe('when is_site_admin() returns true', () => {
    it('returns true for a confirmed admin user', async () => {
      buildRpcClient(true);

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('user-admin-uuid');

      expect(result).toBe(true);
    });

    it('calls rpc("is_site_admin") with the correct p_user_id parameter', async () => {
      buildRpcClient(true);

      const { isAdmin } = await import('../admin');
      await isAdmin('specific-user-id');

      // WHY p_user_id: the function signature is is_site_admin(p_user_id uuid).
      // Parameter name must match migration 040 exactly.
      expect(mockRpc).toHaveBeenCalledWith('is_site_admin', { p_user_id: 'specific-user-id' });
    });
  });

  // --------------------------------------------------------------------------
  // Non-admin paths
  // --------------------------------------------------------------------------

  describe('when is_site_admin() returns false or non-true', () => {
    it('returns false when RPC returns false (user not in site_admins)', async () => {
      buildRpcClient(false);

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('regular-user-uuid');

      expect(result).toBe(false);
    });

    it('returns false when RPC returns null', async () => {
      buildRpcClient(null);

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('partial-profile-uuid');

      expect(result).toBe(false);
    });

    it('returns false when RPC returns undefined', async () => {
      buildRpcClient(undefined);

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('no-flag-uuid');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Fail-closed: errors must never grant access
  // --------------------------------------------------------------------------

  describe('database error handling — fail-closed', () => {
    it('returns false when RPC returns an error (never grants access on failure)', async () => {
      buildRpcClient(null, { message: 'connection refused' });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('any-user-uuid');

      expect(result).toBe(false);
    });

    it('returns false even when RPC data is true but error is also set', async () => {
      // Edge case: error takes priority over data. Fail-closed.
      buildRpcClient(true, { message: 'partial failure' });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('any-user-uuid');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Uses admin client (service-role, not user-scoped)
  // --------------------------------------------------------------------------

  describe('client selection', () => {
    it('uses createAdminClient() for the RPC call', async () => {
      buildRpcClient(true);

      const { isAdmin } = await import('../admin');
      await isAdmin('user-uuid');

      expect(mockCreateAdminClient).toHaveBeenCalledOnce();
    });
  });
});
