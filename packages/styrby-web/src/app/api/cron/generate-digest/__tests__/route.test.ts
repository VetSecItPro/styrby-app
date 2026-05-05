/**
 * Tests for GET /api/cron/generate-digest
 *
 * Covers:
 * - 401 when CRON_SECRET missing/wrong
 * - 400 when period query param is invalid
 * - 200 with generated=0 when no eligible subscriptions
 * - End-to-end happy path: subs → sessions → LLM → insert → email → emailed_at update
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---- Mocks (must be declared before importing route) ----

const mockSendDigestEmail = vi.fn().mockResolvedValue({ success: true });
const mockGenerateDigestContent = vi.fn().mockResolvedValue('You shipped a lot today.');
const mockAdminGetUserById = vi.fn();

vi.mock('@/lib/resend', () => ({
  sendDigestEmail: (...args: unknown[]) => mockSendDigestEmail(...args),
}));

vi.mock('@/lib/digest/generate', () => ({
  generateDigestContent: (...args: unknown[]) => mockGenerateDigestContent(...args),
}));

// Programmable Supabase chain mock — fromCallQueue feeds the next .from()
// call's terminal result. select/eq/in/etc all chain back to the same object.
const fromCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'maybeSingle',
    'upsert',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  // .then makes the chain awaitable like a real PostgrestBuilder.
  chain['then'] = vi.fn().mockImplementation((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb(result))
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => createChainMock(),
    auth: {
      admin: {
        getUserById: (id: string) => mockAdminGetUserById(id),
      },
    },
  }),
}));

// Import AFTER mocks
import { GET } from '../route';

// ---- Helpers ----

function makeRequest(period: string | null, secret = 'test-secret'): NextRequest {
  const url = period
    ? `https://example.com/api/cron/generate-digest?period=${period}`
    : 'https://example.com/api/cron/generate-digest';
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  fromCallQueue.length = 0;
  mockSendDigestEmail.mockClear();
  mockGenerateDigestContent.mockClear();
  mockAdminGetUserById.mockReset();
  process.env.CRON_SECRET = 'test-secret';
});

// ---- Tests ----

describe('GET /api/cron/generate-digest', () => {
  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest('daily'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer token does not match', async () => {
    const res = await GET(makeRequest('daily', 'wrong-secret-123'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when period is invalid', async () => {
    const res = await GET(makeRequest('hourly'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when period is missing', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it('returns 200 with generated=0 when no eligible subscriptions exist', async () => {
    fromCallQueue.push({ data: [], error: null }); // subscriptions query
    const res = await GET(makeRequest('daily'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ generated: 0, emailed: 0, errors: [] });
  });

  it('happy path: generates digest, inserts row, sends email', async () => {
    // 1) subscriptions query → one Growth user
    fromCallQueue.push({
      data: [{ user_id: 'user-123', tier: 'growth' }],
      error: null,
    });
    // 2) sessions query → 2 sessions
    fromCallQueue.push({
      data: [
        {
          id: 's1',
          title: 'Refactor billing',
          agent_type: 'claude',
          status: 'ended',
          total_cost_usd: 0.42,
          message_count: 14,
          created_at: new Date().toISOString(),
        },
        {
          id: 's2',
          title: 'Fix CI',
          agent_type: 'codex',
          status: 'ended',
          total_cost_usd: 0.08,
          message_count: 3,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    // 3) digest_summaries upsert → no error
    fromCallQueue.push({ data: null, error: null });
    // 4) digest_summaries update (emailed_at) → no error
    fromCallQueue.push({ data: null, error: null });

    mockAdminGetUserById.mockResolvedValue({
      data: { user: { id: 'user-123', email: 'pilot@styrby.test' } },
      error: null,
    });

    const res = await GET(makeRequest('daily'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generated).toBe(1);
    expect(body.emailed).toBe(1);
    expect(body.errors).toEqual([]);

    expect(mockGenerateDigestContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateDigestContent).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'daily' })
    );
    expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mockSendDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'pilot@styrby.test',
        period: 'daily',
        sessionCount: 2,
        content: 'You shipped a lot today.',
      })
    );
  });

  it('skips silent when user has zero sessions in window', async () => {
    fromCallQueue.push({
      data: [{ user_id: 'user-123', tier: 'pro' }],
      error: null,
    });
    fromCallQueue.push({ data: [], error: null }); // sessions empty

    const res = await GET(makeRequest('weekly'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generated).toBe(0);
    expect(body.emailed).toBe(0);
    expect(mockSendDigestEmail).not.toHaveBeenCalled();
    expect(mockGenerateDigestContent).not.toHaveBeenCalled();
  });
});
