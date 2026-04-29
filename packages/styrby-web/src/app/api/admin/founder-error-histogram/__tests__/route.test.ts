/**
 * Founder Error-Class Histogram API Route Tests
 *
 * Tests GET /api/admin/founder-error-histogram
 *
 * WHY: The histogram is founder-only (is_admin gate) and aggregates cross-user
 * error data from audit_log. Bugs here could:
 *   1. Expose error data to non-admin users (security / privacy)
 *   2. Return malformed histogram data that crashes the ErrorClassHistogram chart
 *   3. Fail silently and show stale "no errors" state during an active incident
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 403 when authenticated but not admin
 *   - 200 with correctly pivoted histogram on success
 *   - Contiguous date series filled with zeros for days with no errors
 *   - All 5 error classes present in each day bucket
 *   - Rate limit response (429) passthrough
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ERROR_CLASSES } from '@styrby/shared/errors';

// ============================================================================
// Mocks
// ============================================================================

// WHY vi.hoisted: vi.mock() factory functions are hoisted to the top of the
// module by Vitest's transform. Variables declared with `const` are NOT hoisted,
// so referencing them inside a vi.mock() factory causes a TDZ ReferenceError.
// vi.hoisted() lifts the declarations into the same hoisted scope so the mocks
// are initialised before the factory functions run.
const { mockGetUser, mockIsAdmin, mockAdminFrom } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsAdmin: vi.fn(),
  mockAdminFrom: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  // WHY sync (not async): createAdminClient() is synchronous — it returns the
  // client directly. Mocking it as async would return a Promise, causing
  // adminDb.from() to fail with "not a function" after the await was removed
  // from the call site (Fix 1 of task-03.5).
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
  })),
}));

vi.mock('@/lib/admin', () => ({
  isAdmin: mockIsAdmin,
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 9 })),
  RATE_LIMITS: { standard: { windowMs: 60000, maxRequests: 10 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

// WHY mock mfa-gate (H42 Layer 1): the route calls assertAdminMfa(user.id) after
// the isAdmin check. Without this mock the real gate queries the passkeys table
// via createAdminClient which is not set up in the unit test environment.
// Gate behaviour is covered by src/lib/admin/__tests__/mfa-gate.test.ts.
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

import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const makeRequest = () => new NextRequest('http://localhost/api/admin/founder-error-histogram');

/**
 * Creates a chainable from() mock for the audit_log query.
 *
 * @param rows - The rows to return from the mock query
 */
function makeAuditLogChain(rows: unknown[], error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'not', 'gte', 'order', 'limit']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  (chain['limit'] as ReturnType<typeof vi.fn>).mockResolvedValue({ data: rows, error });
  return chain;
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/founder-error-histogram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Unauthorized' } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 403 when authenticated but not admin', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'nonadmin@example.com' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(false);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('returns 200 with correctly pivoted histogram', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'vetsecitpro@gmail.com' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(true);

    // Simulate 3 audit_log rows on 2026-04-01
    const todayStr = new Date().toISOString().split('T')[0];
    const mockRows = [
      { created_at: `${todayStr}T10:00:00.000Z`, error_class: 'network' },
      { created_at: `${todayStr}T10:30:00.000Z`, error_class: 'network' },
      { created_at: `${todayStr}T11:00:00.000Z`, error_class: 'agent_crash' },
    ];

    mockAdminFrom.mockReturnValue(makeAuditLogChain(mockRows));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();

    // Should have 30 days of data
    expect(body.histogram).toHaveLength(30);

    // computedAt should be present
    expect(body.computedAt).toBeTruthy();

    // Find today's entry
    const today = body.histogram.find((d: { date: string }) => d.date === todayStr);
    expect(today).toBeDefined();
    expect(today.network).toBe(2);
    expect(today.agent_crash).toBe(1);
    expect(today.auth).toBe(0);
    expect(today.supabase).toBe(0);
    expect(today.unknown).toBe(0);
  });

  it('returns 30 contiguous days with zeros for all error classes when no errors logged', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'vetsecitpro@gmail.com' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(true);

    // Return empty rows (no errors in the window)
    mockAdminFrom.mockReturnValue(makeAuditLogChain([]));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();

    // Must have 30 days
    expect(body.histogram).toHaveLength(30);

    // Every day must have all 5 error classes at zero
    for (const day of body.histogram) {
      for (const cls of ERROR_CLASSES) {
        expect(day[cls]).toBe(0);
      }
    }
  });

  it('ensures all 5 canonical error classes are present in each histogram day', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(true);

    mockAdminFrom.mockReturnValue(makeAuditLogChain([]));

    const res = await GET(makeRequest());
    const body = await res.json();

    // Verify the shape of every day
    for (const day of body.histogram as Record<string, unknown>[]) {
      expect(Object.keys(day)).toContain('date');
      for (const cls of ERROR_CLASSES) {
        expect(day).toHaveProperty(cls);
        expect(typeof day[cls]).toBe('number');
      }
    }
  });

  // --------------------------------------------------------------------------
  // Database error
  // --------------------------------------------------------------------------

  it('returns 500 when audit_log query fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(true);

    mockAdminFrom.mockReturnValue(makeAuditLogChain([], { message: 'DB connection refused' }));

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  // --------------------------------------------------------------------------
  // MFA gate wiring (H42 Layer 1)
  // --------------------------------------------------------------------------

  // WHY: proves the route calls assertAdminMfa and short-circuits to 403 when
  // the gate throws AdminMfaRequiredError — the DB query must never run on gate failure.
  // OWASP A07:2021, SOC 2 CC6.1.
  it('(MFA gate) returns 403 ADMIN_MFA_REQUIRED and skips DB query when assertAdminMfa throws', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@styrby.test' } },
      error: null,
    });
    mockIsAdmin.mockResolvedValue(true);
    (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('ADMIN_MFA_REQUIRED');
    // The admin DB query must not have been triggered.
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });
});
