/**
 * Retention API Route Tests
 *
 * Tests GET and PUT /api/account/retention.
 *
 * WHY: A regression in retention_days validation could allow arbitrary integers
 * to reach the DB, violating the CHECK constraint in migration 025 and breaking
 * the nightly cron's ability to resolve retention windows. The audit_log write
 * must occur BEFORE the profile update so compliance records survive partial failures.
 *
 * Audit: GDPR Art. 5(1)(e) — storage limitation; SOC2 CC7.2 — audit trail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockAuditInsert = vi.fn();
const mockProfileUpdate = vi.fn();
const mockProfileSelect = vi.fn();

/**
 * Build a minimal Supabase chain mock.
 * Different table calls are intercepted by mockFrom.
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { sensitive: { windowMs: 60000, maxRequests: 10 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED', retryAfter }), { status: 429 }),
  ),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(method: string, body?: object): Request {
  return new Request('http://localhost/api/account/retention', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function setupAuthUser(userId = 'user-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
}

function setupProfileSelect(retentionDays: number | null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { retention_days: retentionDays }, error: null }),
  };
  return chain;
}

function setupProfileUpdate(success = true) {
  const chain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({
      error: success ? null : { message: 'DB error' },
    }),
  };
  return chain;
}

function setupAuditInsert() {
  const chain = {
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
  return chain;
}

// ============================================================================
// GET Tests
// ============================================================================

describe('GET /api/account/retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Not authed') });

    const { GET } = await import('../route');
    const response = await GET(makeRequest('GET'));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 200 with retention_days when authenticated', async () => {
    setupAuthUser();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return setupProfileSelect(30);
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });

    const { GET } = await import('../route');
    const response = await GET(makeRequest('GET'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retention_days).toBe(30);
  });

  it('returns retention_days: null when profile has no retention set', async () => {
    setupAuthUser();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return setupProfileSelect(null);
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });

    const { GET } = await import('../route');
    const response = await GET(makeRequest('GET'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retention_days).toBeNull();
  });
});

// ============================================================================
// PUT Tests
// ============================================================================

describe('PUT /api/account/retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Not authed') });

    const { PUT } = await import('../route');
    const response = await PUT(makeRequest('PUT', { retention_days: 30 }));

    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid retention_days value (e.g. 45)', async () => {
    setupAuthUser();

    const { PUT } = await import('../route');
    const response = await PUT(makeRequest('PUT', { retention_days: 45 }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid');
  });

  it('returns 400 for missing retention_days field', async () => {
    setupAuthUser();

    const { PUT } = await import('../route');
    const response = await PUT(makeRequest('PUT', {}));

    expect(response.status).toBe(400);
  });

  it('returns 200 and writes audit_log before profile update for retention_days: 7', async () => {
    setupAuthUser();

    const auditInsertSpy = vi.fn().mockResolvedValue({ error: null });
    const profileUpdateSpy = vi.fn().mockReturnThis();
    const profileEqSpy = vi.fn().mockResolvedValue({ error: null });

    const callOrder: string[] = [];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'audit_log') {
        return {
          insert: vi.fn((..._args) => {
            callOrder.push('audit_log.insert');
            return auditInsertSpy();
          }),
        };
      }
      if (table === 'profiles') {
        return {
          update: vi.fn((..._args) => {
            callOrder.push('profiles.update');
            return { eq: profileEqSpy };
          }),
        };
      }
      return {};
    });

    const { PUT } = await import('../route');
    const response = await PUT(makeRequest('PUT', { retention_days: 7 }));

    expect(response.status).toBe(200);
    // WHY: audit must come before update (compliance evidence even on partial failure)
    expect(callOrder[0]).toBe('audit_log.insert');
    expect(callOrder[1]).toBe('profiles.update');
  });

  it('returns 200 for retention_days: null (never delete)', async () => {
    setupAuthUser();

    mockFrom.mockImplementation((table: string) => {
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      if (table === 'profiles') return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }) };
      return {};
    });

    const { PUT } = await import('../route');
    const response = await PUT(makeRequest('PUT', { retention_days: null }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retention_days).toBeNull();
  });

  it('returns 200 for all allowed values (7, 30, 90, 365, null)', async () => {
    const allowedValues = [7, 30, 90, 365, null];

    for (const value of allowedValues) {
      vi.clearAllMocks();
      setupAuthUser();

      mockFrom.mockImplementation((table: string) => {
        if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ error: null }) };
        if (table === 'profiles') return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }) };
        return {};
      });

      const { PUT } = await import('../route');
      const response = await PUT(makeRequest('PUT', { retention_days: value }));
      expect(response.status).toBe(200);
    }
  });
});
