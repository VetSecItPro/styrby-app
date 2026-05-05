/**
 * POST /api/v1/auth/exchange — Unit Tests (WAVE-E-008 aal2 enforcement)
 *
 * Test coverage:
 *   1. MFA-enrolled user with aal=aal1  → 403 AAL2_REQUIRED
 *   2. MFA-enrolled user with aal=aal2  → 200 + key minted
 *   3. No-MFA user with aal=aal1        → 200 + audit_log (exchange_without_mfa)
 *   4. Kill switch disables enforcement → 200 even when aal1 + MFA enrolled
 *   5. Pre-existing baseline:           rate-limit + 401 paths unchanged
 *
 * @security WAVE-E-008 — JWT replay defense via aal2 gate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ────────────── Sentry ──────────────
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ────────────── Rate limiter ──────────────
let mockRateLimitAllowed = true;
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({
    allowed: mockRateLimitAllowed,
    remaining: mockRateLimitAllowed ? 9 : 0,
    resetAt: Date.now() + 60_000,
    retryAfter: mockRateLimitAllowed ? undefined : 30,
  })),
  getClientIp: vi.fn(() => '1.2.3.4'),
}));

// ────────────── styrby/shared ──────────────
const MOCK_RAW_KEY = 'styrby_test_exchange_xyz';
vi.mock('@styrby/shared', () => ({
  generateApiKey: vi.fn(() => ({
    key: MOCK_RAW_KEY,
    prefix: 'styrby_',
    randomPart: 'test_exchange_xyz',
  })),
}));

vi.mock('@/lib/api-keys', () => ({
  hashApiKey: vi.fn(async () => '$2b$12$mockhashvalue'),
}));

// ────────────── Supabase admin client ──────────────
type MfaFactor = { id: string; status: string };
let mockGetUserResult: {
  data: { user: { id: string } | null };
  error: { message: string } | null;
} = { data: { user: { id: 'user-uuid-exchange-1' } }, error: null };
let mockMfaFactors: MfaFactor[] = [];
let mockMfaListError: { message: string } | null = null;
let mockInsertCalls: Array<{ table: string; row: unknown }> = [];

const mockGetUser = vi.fn(async (_jwt: string) => mockGetUserResult);
const mockListFactors = vi.fn(async (_args: { userId: string }) => ({
  data: { factors: mockMfaFactors },
  error: mockMfaListError,
}));

const mockFrom = vi.fn((table: string) => ({
  insert: vi.fn(async (row: unknown) => {
    mockInsertCalls.push({ table, row });
    return { error: null, data: null };
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { mfa: { listFactors: mockListFactors } },
    },
    from: mockFrom,
  })),
}));

// Build a minimally-shaped JWT with the given aal claim.
// WHY: route decodes the body claim AFTER getUser() validates signature.
// The mock getUser bypasses signature verification, so we only need the
// payload segment to be valid base64 JSON.
function makeJwt(aal: 'aal1' | 'aal2'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aal, sub: 'user-uuid-exchange-1' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

import { POST } from '../route';

function makeRequest(jwt: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/auth/exchange', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Forwarded-For': '1.2.3.4',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitAllowed = true;
  mockGetUserResult = { data: { user: { id: 'user-uuid-exchange-1' } }, error: null };
  mockMfaFactors = [];
  mockMfaListError = null;
  mockInsertCalls = [];
  delete process.env.EXCHANGE_REQUIRE_AAL2_IF_ENROLLED;
});

describe('POST /api/v1/auth/exchange — WAVE-E-008 aal2 enforcement', () => {
  it('returns 403 AAL2_REQUIRED when user has MFA enrolled but JWT is aal1', async () => {
    mockMfaFactors = [{ id: 'factor-1', status: 'verified' }];
    const res = await POST(makeRequest(makeJwt('aal1')));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('AAL2_REQUIRED');
    expect(body.message).toMatch(/MFA/);
  });

  it('returns 200 + mints key when user has MFA enrolled and JWT is aal2', async () => {
    mockMfaFactors = [{ id: 'factor-1', status: 'verified' }];
    const res = await POST(makeRequest(makeJwt('aal2')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.styrby_api_key).toBe(MOCK_RAW_KEY);
    expect(body.user_id).toBe('user-uuid-exchange-1');
  });

  it('returns 200 and writes audit_log entry when user has NO MFA enrolled (aal1 ok)', async () => {
    mockMfaFactors = []; // no factors
    const res = await POST(makeRequest(makeJwt('aal1')));
    expect(res.status).toBe(200);
    // Audit row must mention exchange_without_mfa.
    // WHY: this is the durable signal for ops to nudge users into MFA enrollment.
    // The insert is fire-and-forget, so wait one microtask cycle for it to land.
    await new Promise((r) => setImmediate(r));
    const auditRow = mockInsertCalls.find(
      (c) =>
        c.table === 'audit_log' &&
        (c.row as { metadata?: { event_subtype?: string } }).metadata?.event_subtype ===
          'exchange_without_mfa',
    );
    expect(auditRow).toBeTruthy();
  });

  it('kill switch (EXCHANGE_REQUIRE_AAL2_IF_ENROLLED=false) bypasses aal2 enforcement', async () => {
    process.env.EXCHANGE_REQUIRE_AAL2_IF_ENROLLED = 'false';
    mockMfaFactors = [{ id: 'factor-1', status: 'verified' }];
    const res = await POST(makeRequest(makeJwt('aal1')));
    expect(res.status).toBe(200);
  });

  it('verified-status filter: unverified factors do NOT count as MFA enrolled', async () => {
    // WHY: an unverified factor is a half-completed enrollment; treating it
    // as "enrolled" would lock the user out before they ever finished setup.
    mockMfaFactors = [{ id: 'factor-1', status: 'unverified' }];
    const res = await POST(makeRequest(makeJwt('aal1')));
    expect(res.status).toBe(200);
  });

  it('returns 401 when JWT is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/exchange', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit denies', async () => {
    mockRateLimitAllowed = false;
    const res = await POST(makeRequest(makeJwt('aal1')));
    expect(res.status).toBe(429);
  });
});
