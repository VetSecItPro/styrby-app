/**
 * Unit tests for GET /api/costs/forecast
 *
 * WHY: The forecast route assembles data from cost_records and computes
 * the EMA-blend prediction. Bugs here produce wrong "cap on <date>" messages
 * in the dashboard and incorrect predictive alert decisions in the cron job.
 *
 * @module api/costs/forecast/__tests__/route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

/**
 * Sequential queue for Supabase .from() calls.
 * The route makes 3 parallel calls: daily records, MTD records, subscription tier.
 * Each entry in this queue is consumed in order by createChainMock().
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: [], error: null };
  const chain: Record<string, unknown> = {};

  for (const method of ['select', 'eq', 'gte', 'order', 'limit', 'not']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
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
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: undefined }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { standard: { windowMs: 60000, maxRequests: 100 } },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { GET } from '../route.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a row with recorded_at + cost_usd for mocking cost_records.
 *
 * @param dateIso - UTC date string (YYYY-MM-DD)
 * @param costUsd - Cost in USD (will be converted to cents in the route)
 */
function makeRow(dateIso: string, costUsd: number) {
  return { recorded_at: `${dateIso}T12:00:00.000Z`, cost_usd: costUsd };
}

/**
 * Builds a NextRequest for the forecast endpoint.
 *
 * @param days - Optional ?days= query param
 */
function makeRequest(days?: number): NextRequest {
  const url = days !== undefined
    ? `http://localhost/api/costs/forecast?days=${days}`
    : 'http://localhost/api/costs/forecast';
  return new NextRequest(url);
}

/**
 * Seeds the from() call queue for a typical successful request.
 *
 * The route makes 3 parallel Supabase calls (Promise.all):
 *   1. Daily cost_records (for the series)
 *   2. MTD cost_records (for elapsedCents)
 *   3. subscriptions (for tier)
 *
 * @param dailyRows - Rows for the daily history query
 * @param mtdRows - Rows for the MTD query
 * @param tier - Subscription tier string
 */
function seedQueue(
  dailyRows: { recorded_at: string; cost_usd: number }[],
  mtdRows: { recorded_at: string; cost_usd: number }[],
  tier: string | null = 'pro'
) {
  fromCallQueue.length = 0; // clear previous state
  fromCallQueue.push({ data: dailyRows, error: null });
  fromCallQueue.push({ data: mtdRows, error: null });
  fromCallQueue.push({ data: tier ? { tier } : null, error: null });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/costs/forecast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-abc' } }, error: null });
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Not authenticated') });
    fromCallQueue.length = 0;

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns a valid forecast for a user with 7 days of spend', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 14 + i)); // Apr 14–20
      return makeRow(d.toISOString().slice(0, 10), 1.0); // $1/day
    });
    seedQueue(rows, rows, 'pro');

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.dailyAverageCents).toBe(100);
    expect(body.trailingWeekAverageCents).toBe(100);
    expect(body.weightedForecastCents['7d']).toBe(700);
    expect(body.weightedForecastCents['14d']).toBe(1400);
    expect(body.weightedForecastCents['30d']).toBe(3000);
    expect(body.isBurnAccelerating).toBe(false);
    expect(body.tier).toBe('pro');
  });

  it('returns null predictedExhaustionDate when quota is null (Power tier)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 22 + i));
      return makeRow(d.toISOString().slice(0, 10), 5.0); // $5/day
    });
    seedQueue(rows, rows, 'power');

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.predictedExhaustionDate).toBeNull();
    expect(body.quotaCents).toBeNull();
    expect(body.tier).toBe('power');
  });

  it('returns a predictedExhaustionDate for a pro user burning toward cap', async () => {
    // Pro cap = $50 (5000 cents). User is at $30 MTD, burning $2/day.
    // remaining = 5000 - 3000 = 2000 cents, rate = ~200 → ~10 days
    const dailyRows = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 22 + i));
      return makeRow(d.toISOString().slice(0, 10), 2.0);
    });
    const mtdRows = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 1 + i));
      return makeRow(d.toISOString().slice(0, 10), 2.0);
    });
    seedQueue(dailyRows, mtdRows, 'pro');

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.predictedExhaustionDate).not.toBeNull();
    // Must be a valid ISO date string
    expect(body.predictedExhaustionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.elapsedCents).toBe(3000); // 15 days * $2 * 100
  });

  it('detects accelerating burn when recent week is >15% over 30-day avg', async () => {
    // First 23 days: $1/day, last 7 days: $2/day
    const rows = [
      ...Array.from({ length: 23 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 2, 22 + i));
        return makeRow(d.toISOString().slice(0, 10), 1.0);
      }),
      ...Array.from({ length: 7 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 3, 14 + i));
        return makeRow(d.toISOString().slice(0, 10), 2.0);
      }),
    ];
    seedQueue(rows, rows.slice(-7), 'pro');

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.isBurnAccelerating).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles empty cost history (new user)', async () => {
    seedQueue([], [], 'free');

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.dailyAverageCents).toBe(0);
    expect(body.trailingWeekAverageCents).toBe(0);
    expect(body.weightedForecastCents['30d']).toBe(0);
    expect(body.predictedExhaustionDate).toBeNull();
    expect(body.isBurnAccelerating).toBe(false);
    expect(body.elapsedCents).toBe(0);
  });

  it('clamps days param to 30 when given a higher value', async () => {
    // Just confirm it responds 200 — the clamping is internal
    seedQueue([], [], 'pro');
    const response = await GET(makeRequest(999));
    expect(response.status).toBe(200);
  });

  it('clamps days param to 1 when given 0', async () => {
    seedQueue([], [], 'pro');
    const response = await GET(makeRequest(0));
    expect(response.status).toBe(200);
  });

  it('handles non-numeric days param gracefully', async () => {
    seedQueue([], [], 'pro');
    const req = new NextRequest('http://localhost/api/costs/forecast?days=banana');
    const response = await GET(req);
    expect(response.status).toBe(200);
  });

  it('defaults tier to free when no subscription found', async () => {
    seedQueue([], [], null); // null means no active subscription row
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.tier).toBe('free');
    // Free tier quota = 500 cents ($5)
    expect(body.quotaCents).toBe(500);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns 500 when cost_records query fails', async () => {
    fromCallQueue.length = 0;
    fromCallQueue.push({ data: null, error: { message: 'DB connection lost' } });
    fromCallQueue.push({ data: [], error: null });
    fromCallQueue.push({ data: { tier: 'pro' }, error: null });

    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Forecast failed');
  });

  // -------------------------------------------------------------------------
  // Cache-Control
  // -------------------------------------------------------------------------

  it('sets Cache-Control: no-store on successful response', async () => {
    seedQueue([], [], 'pro');
    const response = await GET(makeRequest());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
