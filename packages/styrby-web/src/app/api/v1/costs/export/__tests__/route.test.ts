/**
 * GET /api/v1/costs/export — Integration Tests
 *
 * Tests CSV export of cost records (Power-tier only).
 *
 * WHY: CSV export reads up to 50,000 rows of private financial data. Bugs
 * could let non-Power users export data, expose wrong user's records, or
 * produce malformed CSV that breaks Excel/Sheets imports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockAuthContext = {
  userId: 'export-user-123',
  keyId: 'key-export-456',
  scopes: ['read'],
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuth: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
}));

const fromCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'order', 'limit', 'single', 'maybeSingle',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 0 })),
  RATE_LIMITS: {
    export: { windowMs: 3600000, maxRequests: 1 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(queryString = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/costs/export${queryString}`, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer sk_live_test',
      'x-forwarded-for': '10.0.0.1',
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/costs/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Tier enforcement
  // --------------------------------------------------------------------------

  it('returns 403 for free tier users', async () => {
    fromCallQueue.push({ data: { tier: 'free' }, error: null });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    // WHY (Phase 5 rename): error message migrated from "Power tier" to
    // "Pro and Growth plans". Free is still blocked.
    expect(body.error).toContain('Paid plan');
  });

  it('allows pro tier users (Phase 5: Pro inherits power-equivalent features)', async () => {
    // Phase 5 reconciliation: Pro absorbs the old Power feature set, so cost
    // export is now available on Pro.
    fromCallQueue.push({ data: { tier: 'pro' }, error: null });
    // cost_records → empty result (test happy path with no data)
    fromCallQueue.push({ data: [], error: null });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('returns 403 when no subscription found (defaults to free)', async () => {
    fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // Query validation
  // --------------------------------------------------------------------------

  it('returns 400 for days=0 (below minimum)', async () => {
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    const res = await GET(makeRequest('?days=0'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for days=366 (exceeds max 365)', async () => {
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    const res = await GET(makeRequest('?days=366'));
    expect(res.status).toBe(400);
  });

  // --------------------------------------------------------------------------
  // Happy path — CSV response
  // --------------------------------------------------------------------------

  it('returns CSV with correct headers for power user with data', async () => {
    // subscriptions → power
    fromCallQueue.push({ data: { tier: 'power' }, error: null });
    // cost_records → sample rows
    fromCallQueue.push({
      data: [
        {
          recorded_at: '2026-01-15T10:00:00Z',
          session_id: '00000000-0000-0000-0000-000000000001',
          agent_type: 'claude',
          model: 'claude-sonnet-4',
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          cost_usd: 0.0025,
        },
      ],
      error: null,
    });

    const res = await GET(makeRequest('?days=7'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="styrby-costs-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const text = await res.text();
    // Verify CSV header row
    expect(text).toContain('date,session_id,agent_type,model,input_tokens,output_tokens,cache_tokens,cost_usd');
    // Verify data row
    expect(text).toContain('claude');
    expect(text).toContain('claude-sonnet-4');
  });

  it('returns CSV with only header row when no records exist', async () => {
    fromCallQueue.push({ data: { tier: 'power' }, error: null });
    fromCallQueue.push({ data: [], error: null });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Only the header line, no extra rows
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('date,session_id,agent_type,model,input_tokens,output_tokens,cache_tokens,cost_usd');
  });

  it('uses RFC 4180 CRLF line endings', async () => {
    fromCallQueue.push({ data: { tier: 'power' }, error: null });
    fromCallQueue.push({
      data: [
        {
          recorded_at: '2026-01-20T00:00:00Z',
          session_id: '00000000-0000-0000-0000-000000000002',
          agent_type: 'codex',
          model: 'gpt-4o',
          input_tokens: 500,
          output_tokens: 250,
          cache_read_tokens: 0,
          cost_usd: 0.001,
        },
      ],
      error: null,
    });

    const res = await GET(makeRequest());
    const text = await res.text();
    // CRLF line endings per RFC 4180
    expect(text).toContain('\r\n');
  });

  // --------------------------------------------------------------------------
  // DB error
  // --------------------------------------------------------------------------

  it('returns 500 when cost_records query fails', async () => {
    fromCallQueue.push({ data: { tier: 'power' }, error: null });
    fromCallQueue.push({ data: null, error: { message: 'timeout' } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  it('returns 429 when rate limited', async () => {
    const { rateLimit } = await import('@/lib/rateLimit');
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 3600, remaining: 0, resetAt: Date.now() + 3600000 });
    // Tier check happens after rate limit in handler
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
  });
});
