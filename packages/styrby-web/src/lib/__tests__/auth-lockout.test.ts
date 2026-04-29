/**
 * Auth Lockout Tests (H42 Item 3)
 *
 * Tests the account lockout utility functions:
 * - checkLockoutStatus: returns correct locked/unlocked state
 * - recordLoginFailure: increments counter; triggers lockout after 5 failures within 1 hour
 * - resetLoginFailures: resets counter on successful auth
 * - lockoutResponse: returns 423 with Retry-After header
 * - Admin exemption: site admins are never locked out
 *
 * WHY: Lockout is a security-critical control (SOC2 CC6.6, NIST SP 800-63B §5.2.2).
 * Bugs could either allow brute-force attacks (lockout never fires) or
 * create denial-of-service (lockout fires too aggressively or never resets).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: mockRpc,
    from: mockFrom,
  })),
}));

// Import AFTER mocks
import {
  checkLockoutStatus,
  recordLoginFailure,
  resetLoginFailures,
  lockoutResponse,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_DURATION_SECONDS,
  LOCKOUT_WINDOW_SECONDS,
} from '../auth-lockout';

// ============================================================================
// Helpers
// ============================================================================

/** A non-admin user profile mock */
function mockNonAdminProfile() {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { is_site_admin: false }, error: null }),
  });
}

/** An admin user profile mock */
function mockAdminProfile() {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { is_site_admin: true }, error: null }),
  });
}

const TEST_USER_ID = 'user-uuid-test-0001';
const FUTURE_LOCKED_UNTIL = new Date(Date.now() + LOCKOUT_DURATION_SECONDS * 1000).toISOString();
const PAST_LOCKED_UNTIL = new Date(Date.now() - 1000).toISOString();

// ============================================================================
// checkLockoutStatus
// ============================================================================

describe('checkLockoutStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isLocked=false when no lockout record exists', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({ data: [], error: null });

    const status = await checkLockoutStatus(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
    expect(status.lockedUntil).toBeNull();
    expect(status.failedCount).toBe(0);
  });

  it('returns isLocked=false when locked_until is in the past (expired lockout)', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({
      data: [{ is_locked: false, locked_until: PAST_LOCKED_UNTIL, failed_count: 3 }],
      error: null,
    });

    const status = await checkLockoutStatus(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
  });

  it('returns isLocked=true when locked_until is in the future', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({
      data: [{ is_locked: true, locked_until: FUTURE_LOCKED_UNTIL, failed_count: 5 }],
      error: null,
    });

    const status = await checkLockoutStatus(TEST_USER_ID);

    expect(status.isLocked).toBe(true);
    expect(status.lockedUntil).toBe(FUTURE_LOCKED_UNTIL);
  });

  it('returns isLocked=false when RPC errors (fail-open policy)', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({ data: null, error: { message: 'DB error' } });

    const status = await checkLockoutStatus(TEST_USER_ID);

    // WHY fail-open: a DB outage should not block all logins
    expect(status.isLocked).toBe(false);
    expect(status.lockedUntil).toBeNull();
  });

  it('always returns isLocked=false for site admins (exempt)', async () => {
    mockAdminProfile();
    // RPC should NOT be called for admins
    mockRpc.mockResolvedValue({ data: [{ is_locked: true, locked_until: FUTURE_LOCKED_UNTIL, failed_count: 5 }], error: null });

    const status = await checkLockoutStatus(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
    // Admin short-circuits before the lockout RPC
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ============================================================================
// recordLoginFailure
// ============================================================================

describe('recordLoginFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isLocked=false when failure count is below threshold', async () => {
    mockNonAdminProfile();
    // RPC returns null locked_until (not yet locked)
    mockRpc.mockResolvedValue({ data: null, error: null });

    const status = await recordLoginFailure(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
    expect(status.lockedUntil).toBeNull();
  });

  it('returns isLocked=true when threshold is reached (5th failure)', async () => {
    mockNonAdminProfile();
    // RPC returns a locked_until in the future
    mockRpc.mockResolvedValue({ data: FUTURE_LOCKED_UNTIL, error: null });

    const status = await recordLoginFailure(TEST_USER_ID);

    expect(status.isLocked).toBe(true);
    expect(status.lockedUntil).toBe(FUTURE_LOCKED_UNTIL);
  });

  it('triggers lockout after LOCKOUT_MAX_FAILURES failures', async () => {
    // Simulate 5 sequential failure calls, last one returning locked_until
    mockNonAdminProfile();

    // First 4 calls: not yet locked
    for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) {
      mockNonAdminProfile(); // re-mock for each call
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      const s = await recordLoginFailure(TEST_USER_ID);
      expect(s.isLocked).toBe(false);
    }

    // 5th call: locked
    mockNonAdminProfile();
    mockRpc.mockResolvedValueOnce({ data: FUTURE_LOCKED_UNTIL, error: null });
    const finalStatus = await recordLoginFailure(TEST_USER_ID);

    expect(finalStatus.isLocked).toBe(true);
    expect(LOCKOUT_MAX_FAILURES).toBe(5);
    expect(LOCKOUT_DURATION_SECONDS).toBe(900); // 15 minutes
  });

  it('returns isLocked=false when RPC errors (fail-open)', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({ data: null, error: { message: 'DB write failed' } });

    const status = await recordLoginFailure(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
  });

  it('is a no-op for site admins (exempt from lockout)', async () => {
    mockAdminProfile();
    // RPC should NOT be called
    mockRpc.mockResolvedValue({ data: FUTURE_LOCKED_UNTIL, error: null });

    const status = await recordLoginFailure(TEST_USER_ID);

    expect(status.isLocked).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('lockout expires after LOCKOUT_DURATION_SECONDS (15 min) — constant check', () => {
    // Validate our policy constants match the spec (H42 Item 3)
    expect(LOCKOUT_DURATION_SECONDS).toBe(900); // 15 * 60
    expect(LOCKOUT_WINDOW_SECONDS).toBe(3600);  // 1 hour
    expect(LOCKOUT_MAX_FAILURES).toBe(5);
  });
});

// ============================================================================
// resetLoginFailures
// ============================================================================

describe('resetLoginFailures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls reset RPC for non-admin users', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({ data: null, error: null });

    await resetLoginFailures(TEST_USER_ID);

    expect(mockRpc).toHaveBeenCalledWith('reset_login_failures', { p_user_id: TEST_USER_ID });
  });

  it('does not call reset RPC for admin users (exempt)', async () => {
    mockAdminProfile();

    await resetLoginFailures(TEST_USER_ID);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not throw when RPC errors (non-critical path)', async () => {
    mockNonAdminProfile();
    mockRpc.mockResolvedValue({ data: null, error: { message: 'transient error' } });

    // Should not throw — failure to reset is non-critical
    await expect(resetLoginFailures(TEST_USER_ID)).resolves.toBeUndefined();
  });
});

// ============================================================================
// lockoutResponse
// ============================================================================

describe('lockoutResponse', () => {
  it('returns status 423', async () => {
    const lockedUntil = new Date(Date.now() + 600000).toISOString(); // 10 min
    const response = lockoutResponse(lockedUntil);

    expect(response.status).toBe(423);
  });

  it('includes Retry-After header', async () => {
    const lockedUntil = new Date(Date.now() + 600000).toISOString(); // 10 min
    const response = lockoutResponse(lockedUntil);

    const retryAfter = response.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    const retrySeconds = Number(retryAfter);
    expect(retrySeconds).toBeGreaterThan(0);
    expect(retrySeconds).toBeLessThanOrEqual(600); // ≤ 10 min
  });

  it('includes Content-Type: application/json', async () => {
    const lockedUntil = new Date(Date.now() + 60000).toISOString();
    const response = lockoutResponse(lockedUntil);

    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('body contains ACCOUNT_LOCKED error code', async () => {
    const lockedUntil = new Date(Date.now() + 60000).toISOString();
    const response = lockoutResponse(lockedUntil);
    const body = await response.json();

    expect(body.error).toBe('ACCOUNT_LOCKED');
    expect(typeof body.retryAfter).toBe('number');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('Retry-After is at least 1 second even for very near lock expiry', async () => {
    // Lock expires in 1ms — should round up to 1 second
    const almostNow = new Date(Date.now() + 1).toISOString();
    const response = lockoutResponse(almostNow);

    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});
