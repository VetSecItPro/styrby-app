/**
 * Tests for POST /api/auth/passkey/challenge
 *
 * Verifies:
 * - Valid actions (challenge-register, challenge-login) are forwarded
 * - Invalid actions are rejected with 400
 * - Missing/malformed JSON returns 400
 * - Rate limit returns 429 with Retry-After
 * - Edge function errors propagate as 502
 * - Authorization and cookie headers are forwarded
 * - Response body is forwarded verbatim
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockRateLimit = vi.fn();
const mockRateLimitResponse = vi.fn();

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: mockRateLimit,
  rateLimitResponse: mockRateLimitResponse,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/passkey/challenge', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co');

    // Default: rate limit allows request
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });

    // Fresh module import after env stub
    const mod = await import('../challenge/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects unknown action with 400', async () => {
    const req = makeRequest({ action: 'do-something-bad' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('INVALID_ACTION');
  });

  it('rejects missing action with 400', async () => {
    const req = makeRequest({ email: 'user@example.com' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('INVALID_ACTION');
  });

  it('returns 400 for malformed JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/passkey/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('INVALID_JSON');
  });

  it('returns 429 when rate limited', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 45 });
    mockRateLimitResponse.mockReturnValue(
      new Response(JSON.stringify({ error: 'RATE_LIMITED', retryAfter: 45 }), { status: 429 }),
    );

    const req = makeRequest({ action: 'challenge-login', email: 'user@example.com' });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(mockRateLimitResponse).toHaveBeenCalledWith(45);
  });

  it('forwards challenge-register to edge function and returns response', async () => {
    const edgePayload = { challenge: 'base64url-challenge', userId: 'uid-123' };

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(edgePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'challenge-register' }, { Authorization: 'Bearer tok' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.challenge).toBe('base64url-challenge');

    // Verify the edge function was called with the right URL
    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/verify-passkey',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'challenge-register' }),
      }),
    );
  });

  it('forwards challenge-login to edge function', async () => {
    const edgePayload = { challenge: 'login-challenge' };

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(edgePayload), { status: 200 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'challenge-login', email: 'user@example.com' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.challenge).toBe('login-challenge');
  });

  it('returns 502 when edge function is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as typeof fetch;

    const req = makeRequest({ action: 'challenge-login', email: 'user@example.com' });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('EDGE_FUNCTION_ERROR');
  });

  it('forwards Authorization header to edge function', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    ) as typeof fetch;

    const req = makeRequest(
      { action: 'challenge-register' },
      { Authorization: 'Bearer eyJtest' },
    );
    await POST(req);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer eyJtest');
  });

  it('propagates non-200 edge function responses', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'challenge-register' });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });
});
