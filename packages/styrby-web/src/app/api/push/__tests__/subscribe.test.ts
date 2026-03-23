/**
 * Tests for push subscription and unsubscription API routes.
 *
 * Validates authentication, input validation (including SSRF protection),
 * rate limiting, and database operations for both the subscribe and
 * unsubscribe endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports that use them)
// ---------------------------------------------------------------------------

/**
 * Mock Supabase client returned by createClient().
 * Each test can override the behavior of auth.getUser(), from().upsert(), etc.
 */
const mockSupabaseClient = {
  auth: {
    getUser: vi.fn(),
  },
  from: vi.fn(),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseClient),
}));

/**
 * Mock rate limiter. Defaults to allowing requests; individual tests override.
 */
const mockRateLimit = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 4,
  resetAt: Date.now() + 60_000,
});

const mockRateLimitResponse = vi.fn((retryAfter: number) => {
  return new Response(
    JSON.stringify({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  );
});

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  rateLimitResponse: (retryAfter: number) => mockRateLimitResponse(retryAfter),
  RATE_LIMITS: {
    standard: { windowMs: 60000, maxRequests: 100 },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-subscription-id';
const VALID_MOZILLA_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/test-id';

/**
 * Builds a valid push subscription body for testing.
 *
 * @param overrides - Fields to override in the subscription
 * @returns A JSON-serializable push subscription object
 */
function validSubscriptionBody(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: VALID_FCM_ENDPOINT,
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfYJQ',
      auth: 'tBHItJI5svbpC7htIGjK-g',
    },
    expirationTime: null,
    ...overrides,
  };
}

/**
 * Creates a NextRequest suitable for testing POST /api/push/subscribe.
 *
 * @param body - The request body
 * @returns A NextRequest instance
 */
function makeSubscribeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Creates a NextRequest suitable for testing DELETE /api/push/unsubscribe.
 *
 * @param body - The request body
 * @returns A NextRequest instance
 */
function makeUnsubscribeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/push/unsubscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Sets up the mock Supabase client to return a user for authenticated tests.
 *
 * @param userId - The user ID to return
 */
function mockAuthenticatedUser(userId: string = 'user-uuid-123') {
  mockSupabaseClient.auth.getUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
}

/**
 * Sets up the mock Supabase client to return an auth error.
 */
function mockUnauthenticated() {
  mockSupabaseClient.auth.getUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Unauthorized' },
  });
}

// ---------------------------------------------------------------------------
// Subscribe Tests
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe', () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });

    // Dynamic import to pick up the fresh mocks each time
    const mod = await import('@/app/api/push/subscribe/route');
    POST = mod.POST;
  });

  // -----------------------------------------------------------------------
  // 4A.2.1: Returns 201 on valid subscription
  // -----------------------------------------------------------------------
  it('returns 201 on valid subscription with FCM endpoint', async () => {
    mockAuthenticatedUser();
    mockSupabaseClient.from.mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });

    const response = await POST(makeSubscribeRequest(validSubscriptionBody()));

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json).toEqual({ success: true });
  });

  it('returns 201 on valid subscription with Mozilla push endpoint', async () => {
    mockAuthenticatedUser();
    mockSupabaseClient.from.mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });

    const body = validSubscriptionBody({ endpoint: VALID_MOZILLA_ENDPOINT });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(201);
  });

  it('upserts the subscription into device_tokens with correct fields', async () => {
    mockAuthenticatedUser('user-abc');
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseClient.from.mockReturnValue({ upsert: mockUpsert });

    const body = validSubscriptionBody();
    await POST(makeSubscribeRequest(body));

    expect(mockSupabaseClient.from).toHaveBeenCalledWith('device_tokens');
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        user_id: 'user-abc',
        token: VALID_FCM_ENDPOINT,
        platform: 'web',
        web_push_subscription: body,
        is_active: true,
      },
      { onConflict: 'user_id,token' }
    );
  });

  // -----------------------------------------------------------------------
  // 4A.2.2: Returns 401 when unauthenticated
  // -----------------------------------------------------------------------
  it('returns 401 when user is not authenticated', async () => {
    mockUnauthenticated();

    const response = await POST(makeSubscribeRequest(validSubscriptionBody()));

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ error: 'Unauthorized' });
  });

  // -----------------------------------------------------------------------
  // 4A.2.3: Returns 400 on invalid body
  // -----------------------------------------------------------------------
  it('returns 400 when endpoint is missing', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody();
    delete (body as Record<string, unknown>).endpoint;
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  it('returns 400 when keys.p256dh is empty', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ keys: { p256dh: '', auth: 'valid' } });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  it('returns 400 when keys.auth is empty', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ keys: { p256dh: 'valid', auth: '' } });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  it('returns 400 when keys object is missing', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody();
    delete (body as Record<string, unknown>).keys;
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  it('returns 400 when endpoint is not a valid URL', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ endpoint: 'not-a-url' });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 4A.2.4: SSRF protection - rejects non-push-service endpoints
  // -----------------------------------------------------------------------
  it('returns 400 when endpoint is not a recognized push service (SSRF check)', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ endpoint: 'https://evil.example.com/webhook' });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('recognized push service');
  });

  it('returns 400 for localhost endpoints (SSRF check)', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ endpoint: 'https://localhost:3000/api/internal' });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  it('returns 400 for internal IP endpoints (SSRF check)', async () => {
    mockAuthenticatedUser();

    const body = validSubscriptionBody({ endpoint: 'https://192.168.1.1/callback' });
    const response = await POST(makeSubscribeRequest(body));

    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 4A.2.5: Rate limiting
  // -----------------------------------------------------------------------
  it('returns 429 when rate limited', async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60000,
      retryAfter: 30,
    });

    const response = await POST(makeSubscribeRequest(validSubscriptionBody()));

    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error).toBe('RATE_LIMITED');
  });

  // -----------------------------------------------------------------------
  // 4A.2.6: Database error handling
  // -----------------------------------------------------------------------
  it('returns 500 when upsert fails', async () => {
    mockAuthenticatedUser();
    mockSupabaseClient.from.mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
    });

    const response = await POST(makeSubscribeRequest(validSubscriptionBody()));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe('Failed to save push subscription');
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe Tests
// ---------------------------------------------------------------------------

describe('DELETE /api/push/unsubscribe', () => {
  let DELETE: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });

    const mod = await import('@/app/api/push/unsubscribe/route');
    DELETE = mod.DELETE;
  });

  // -----------------------------------------------------------------------
  // 4A.2.7: Returns 200 on valid unsubscribe
  // -----------------------------------------------------------------------
  it('returns 200 on valid unsubscribe', async () => {
    mockAuthenticatedUser('user-abc');

    const mockDelete = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });
    mockSupabaseClient.from.mockReturnValue({ delete: mockDelete });

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: VALID_FCM_ENDPOINT })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ success: true });
  });

  it('deletes with user_id and token filters', async () => {
    mockAuthenticatedUser('user-xyz');

    const mockEq2 = vi.fn().mockResolvedValue({ error: null });
    const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 });
    const mockDeleteFn = vi.fn().mockReturnValue({ eq: mockEq1 });
    mockSupabaseClient.from.mockReturnValue({ delete: mockDeleteFn });

    await DELETE(
      makeUnsubscribeRequest({ endpoint: VALID_FCM_ENDPOINT })
    );

    expect(mockSupabaseClient.from).toHaveBeenCalledWith('device_tokens');
    expect(mockEq1).toHaveBeenCalledWith('user_id', 'user-xyz');
    expect(mockEq2).toHaveBeenCalledWith('token', VALID_FCM_ENDPOINT);
  });

  // -----------------------------------------------------------------------
  // 4A.2.8: Returns 401 when unauthenticated
  // -----------------------------------------------------------------------
  it('returns 401 when user is not authenticated', async () => {
    mockUnauthenticated();

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: VALID_FCM_ENDPOINT })
    );

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ error: 'Unauthorized' });
  });

  // -----------------------------------------------------------------------
  // 4A.2.9: Returns 400 on invalid endpoint
  // -----------------------------------------------------------------------
  it('returns 400 when endpoint is not a valid URL', async () => {
    mockAuthenticatedUser();

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: 'not-a-url' })
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when endpoint is not a recognized push service', async () => {
    mockAuthenticatedUser();

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: 'https://evil.example.com/callback' })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('recognized push service');
  });

  it('returns 400 when endpoint is missing', async () => {
    mockAuthenticatedUser();

    const response = await DELETE(makeUnsubscribeRequest({}));

    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 4A.2.10: Rate limiting
  // -----------------------------------------------------------------------
  it('returns 429 when rate limited', async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60000,
      retryAfter: 45,
    });

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: VALID_FCM_ENDPOINT })
    );

    expect(response.status).toBe(429);
  });

  // -----------------------------------------------------------------------
  // 4A.2.11: Database error handling
  // -----------------------------------------------------------------------
  it('returns 500 when delete fails', async () => {
    mockAuthenticatedUser();

    const mockEq2 = vi.fn().mockResolvedValue({ error: { message: 'DB error' } });
    const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 });
    mockSupabaseClient.from.mockReturnValue({
      delete: vi.fn().mockReturnValue({ eq: mockEq1 }),
    });

    const response = await DELETE(
      makeUnsubscribeRequest({ endpoint: VALID_FCM_ENDPOINT })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe('Failed to remove push subscription');
  });
});
