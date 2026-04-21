/**
 * Push Unsubscribe Route Tests
 *
 * Tests DELETE /api/push/unsubscribe.
 *
 * WHY: The endpoint includes SSRF protection via an allowlist of known push
 * service hostnames. Regressions could open an SSRF vector or silently fail
 * to remove subscriptions, leading to ghost push tokens in the DB.
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

  for (const method of ['delete', 'eq', 'single', 'select']) {
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

import { DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const AUTH_USER = { id: 'user-push-999', email: 'user@example.com' };

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: AUTH_USER }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } });
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/push/unsubscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
    body: JSON.stringify(body),
  });
}

// Known-good push endpoints from the allowlist
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects/styrby/messages:send?token=abc123';
const MOZILLA_ENDPOINT = 'https://updates.push.services.mozilla.com/push/v1/abcdef1234567890';
const APPLE_ENDPOINT = 'https://web.push.apple.com/push/v1/somepushtoken';

// ============================================================================
// Tests
// ============================================================================

describe('DELETE /api/push/unsubscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();
    const res = await DELETE(makeRequest({ endpoint: FCM_ENDPOINT }));
    expect(res.status).toBe(401);
  });

  // --------------------------------------------------------------------------
  // Input validation
  // --------------------------------------------------------------------------

  it('rejects missing endpoint', async () => {
    mockAuthenticated();
    const res = await DELETE(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects non-URL endpoint', async () => {
    mockAuthenticated();
    const res = await DELETE(makeRequest({ endpoint: 'not-a-url' }));
    expect(res.status).toBe(400);
  });

  it('rejects endpoint from disallowed host (SSRF guard)', async () => {
    mockAuthenticated();
    const res = await DELETE(makeRequest({ endpoint: 'https://internal.corp.local/push/token' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('push service');
  });

  it('rejects endpoint that is too long (>2048 chars)', async () => {
    mockAuthenticated();
    const res = await DELETE(makeRequest({ endpoint: 'https://fcm.googleapis.com/' + 'x'.repeat(2040) }));
    expect(res.status).toBe(400);
  });

  // --------------------------------------------------------------------------
  // SSRF allowlist — accepted hosts
  // --------------------------------------------------------------------------

  it('accepts FCM endpoint and deletes subscription', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: null, error: null }); // delete success

    const res = await DELETE(makeRequest({ endpoint: FCM_ENDPOINT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('accepts Mozilla push endpoint', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: null, error: null });

    const res = await DELETE(makeRequest({ endpoint: MOZILLA_ENDPOINT }));
    expect(res.status).toBe(200);
  });

  it('accepts Apple Web Push endpoint', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: null, error: null });

    const res = await DELETE(makeRequest({ endpoint: APPLE_ENDPOINT }));
    expect(res.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // DB error handling
  // --------------------------------------------------------------------------

  it('returns 500 on delete DB error', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: null, error: { message: 'constraint violation' } });

    const res = await DELETE(makeRequest({ endpoint: FCM_ENDPOINT }));
    expect(res.status).toBe(500);
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  it('returns 429 when rate limited', async () => {
    const { rateLimit } = await import('@/lib/rateLimit');
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60, remaining: 0, resetAt: Date.now() + 60000 });

    const res = await DELETE(makeRequest({ endpoint: FCM_ENDPOINT }));
    expect(res.status).toBe(429);
  });
});
