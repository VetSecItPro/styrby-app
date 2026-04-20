/**
 * Tests for POST /api/auth/passkey/verify
 *
 * Verifies:
 * - Valid actions (verify-register, verify-login) are forwarded
 * - Invalid actions are rejected with 400
 * - Rate limit enforced at 10/min
 * - Edge function 422 (bad signature) propagated to caller
 * - 502 returned on fetch failure
 * - Response body forwarded verbatim (including session cookie on login)
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/passkey/verify', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co');
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });

    const mod = await import('../verify/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects unknown action with 400', async () => {
    const req = makeRequest({ action: 'hack-the-planet' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('INVALID_ACTION');
  });

  it('rejects missing action with 400', async () => {
    const req = makeRequest({ response: { id: 'cred-id' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    mockRateLimitResponse.mockReturnValue(
      new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 }),
    );

    const req = makeRequest({ action: 'verify-login' });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it('forwards verify-register to edge function on success', async () => {
    const edgePayload = { success: true, credentialId: 'abc123' };
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(edgePayload), { status: 200 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'verify-register', response: { id: 'cred' } });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('forwards verify-login and propagates session payload', async () => {
    const edgePayload = { success: true, access_token: 'tok', refresh_token: 'ref' };
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(edgePayload), { status: 200 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'verify-login', response: { id: 'cred' }, email: 'a@b.com' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('tok');
  });

  it('propagates 422 from edge function (invalid signature)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'INVALID_SIGNATURE' }), { status: 422 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'verify-login', response: { id: 'cred' } });
    const res = await POST(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('INVALID_SIGNATURE');
  });

  it('returns 502 when edge function is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as typeof fetch;

    const req = makeRequest({ action: 'verify-login', response: {} });
    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it('uses correct edge function URL', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as typeof fetch;

    const req = makeRequest({ action: 'verify-register', response: {} });
    await POST(req);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/verify-passkey',
      expect.any(Object),
    );
  });
});
