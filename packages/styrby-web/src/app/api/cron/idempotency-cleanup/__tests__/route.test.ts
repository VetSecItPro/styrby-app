/**
 * Tests for POST /api/cron/idempotency-cleanup — auth gate.
 *
 * Covers (bug #30): timingSafeEqual must never throw a RangeError on a
 * wrong-LENGTH token. Every unauthorized case (missing, empty, short, long,
 * same-length-wrong) must return a clean 401 — never a 500.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Admin client is only reached AFTER auth passes; the auth-failure tests never
// touch it, but we stub it so module import succeeds.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
    from: () => ({
      delete: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ data: null, error: null, count: 0 }),
    }),
  }),
}));

import { POST } from '../route';

const CRON_SECRET = 'test-cron-secret-value';

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/idempotency-cleanup', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
});

describe('POST /api/cron/idempotency-cleanup auth gate (bug #30)', () => {
  it('returns 401 (not 500) when the authorization header is missing', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 500) for an empty bearer token', async () => {
    const res = await POST(makeRequest('Bearer '));
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 500) for a SHORTER wrong-length token', async () => {
    const res = await POST(makeRequest('Bearer short'));
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 500) for a LONGER wrong-length token', async () => {
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}-extra-bytes`));
    expect(res.status).toBe(401);
  });

  it('returns 401 for a same-length but wrong-value token', async () => {
    const wrong = 'x'.repeat(CRON_SECRET.length);
    const res = await POST(makeRequest(`Bearer ${wrong}`));
    expect(res.status).toBe(401);
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
  });
});
