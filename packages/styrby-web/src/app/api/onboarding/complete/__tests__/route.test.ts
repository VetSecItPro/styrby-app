/**
 * Onboarding Complete Route Tests
 *
 * Tests POST /api/onboarding/complete.
 *
 * WHY: This endpoint marks onboarding complete by updating profiles. Regressions
 * could leave users stuck in onboarding forever (DB error path) or allow
 * unauthenticated calls to reset other users' onboarding state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

const fromCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of ['update', 'eq', 'select', 'single']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 4 })),
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const AUTH_USER = { id: 'user-onboard-42', email: 'dev@example.com' };

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: AUTH_USER }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } });
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/onboarding/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 200 with success: true when authenticated and DB update succeeds', async () => {
    mockAuthenticated();
    // profiles.update().eq() → no error
    fromCallQueue.push({ data: null, error: null });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 500 when DB update fails', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: null, error: { message: 'column not found' } });

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to complete onboarding');
  });

  it('returns 429 when rate limited', async () => {
    const { rateLimit } = await import('@/lib/rateLimit');
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60, remaining: 0, resetAt: Date.now() + 60000 });

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
  });
});
