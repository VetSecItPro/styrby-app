/**
 * Tests for the admin authorization utility.
 *
 * WHY these tests matter: isAdmin() is the sole gate protecting every admin
 * endpoint. If it returns true for a non-admin user — due to a bug in the
 * query, null handling, or type coercion — any authenticated user becomes an
 * admin. These tests verify every trust boundary.
 *
 * Covers:
 * - Returns true only when is_admin === true (server-set column)
 * - Returns false for is_admin === false
 * - Returns false when is_admin is null/undefined (profile exists but unset)
 * - Returns false when the profile row does not exist (Supabase returns null)
 * - Returns false immediately for empty/falsy userId (no DB query needed)
 * - Database errors do not grant admin access (fail-closed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockFrom = vi.fn();
const mockCreateAdminClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: mockCreateAdminClient,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a chainable Supabase query builder stub that resolves to the given data.
 *
 * @param data - The simulated row returned from `.single()`
 * @param error - Optional error to simulate a failed query
 */
function buildQueryChain(
  data: { is_admin?: boolean | null } | null,
  error: { message: string } | null = null
) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
  return chain;
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
  // Admin: is_admin === true
  // --------------------------------------------------------------------------

  describe('when is_admin is true', () => {
    it('returns true for a confirmed admin user', async () => {
      const chain = buildQueryChain({ is_admin: true });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('user-admin-uuid');

      expect(result).toBe(true);
    });

    it('queries the profiles table using the correct user ID', async () => {
      const chain = buildQueryChain({ is_admin: true });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      await isAdmin('specific-user-id');

      expect(mockFrom).toHaveBeenCalledWith('profiles');
      expect(chain.eq).toHaveBeenCalledWith('id', 'specific-user-id');
      expect(chain.select).toHaveBeenCalledWith('is_admin');
    });
  });

  // --------------------------------------------------------------------------
  // Non-admin paths
  // --------------------------------------------------------------------------

  describe('when is_admin is not true', () => {
    it('returns false when is_admin is explicitly false', async () => {
      const chain = buildQueryChain({ is_admin: false });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('regular-user-uuid');

      expect(result).toBe(false);
    });

    it('returns false when is_admin is null (profile exists but flag unset)', async () => {
      const chain = buildQueryChain({ is_admin: null });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('partial-profile-uuid');

      expect(result).toBe(false);
    });

    it('returns false when is_admin is undefined', async () => {
      const chain = buildQueryChain({});
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('no-flag-uuid');

      expect(result).toBe(false);
    });

    it('returns false when the profile row does not exist (data is null)', async () => {
      const chain = buildQueryChain(null);
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('no-profile-uuid');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Fail-closed: errors must never grant access
  // --------------------------------------------------------------------------

  describe('database error handling — fail-closed', () => {
    it('returns false when Supabase returns an error (never grants access on failure)', async () => {
      const chain = buildQueryChain(null, { message: 'connection refused' });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      const result = await isAdmin('any-user-uuid');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Uses admin client (bypasses RLS)
  // --------------------------------------------------------------------------

  describe('client selection', () => {
    it('uses the admin client so RLS cannot interfere with the check', async () => {
      const chain = buildQueryChain({ is_admin: true });
      mockFrom.mockReturnValue(chain);
      mockCreateAdminClient.mockReturnValue({ from: mockFrom });

      const { isAdmin } = await import('../admin');
      await isAdmin('user-uuid');

      expect(mockCreateAdminClient).toHaveBeenCalledOnce();
    });
  });
});
