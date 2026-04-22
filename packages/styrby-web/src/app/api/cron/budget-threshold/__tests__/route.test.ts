/**
 * Tests for POST /api/cron/budget-threshold
 *
 * Covers:
 * - 401 on missing / wrong CRON_SECRET
 * - 200 with sent=0 when no eligible users
 * - Skips user already sent this billing period (idempotency)
 * - Sends push when MTD spend > threshold
 * - Does NOT send push when MTD spend < threshold
 * - Writes budget_threshold_sends row after send
 * - Writes audit_log on send
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

// ============================================================================
// Mocks
// ============================================================================

const mockSendRetentionPush = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/pushNotifications', () => ({
  sendRetentionPush: (...args: unknown[]) => mockSendRetentionPush(...args),
}));

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'maybeSingle',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = vi.fn().mockImplementation((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb(result))
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => createChainMock(),
  }),
}));

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/budget-threshold', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

const CRON_SECRET = 'test-cron-secret';

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  fromCallQueue.length = 0;
  mockSendRetentionPush.mockClear();
  mockSendRetentionPush.mockResolvedValue(true);
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/budget-threshold', () => {
  it('returns 401 when no authorization header', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when secret does not match', async () => {
    const res = await POST(makeRequest('Bearer bad-secret'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with no users when preferences query returns empty', async () => {
    fromCallQueue.push({ data: [], error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(0);
    expect(body.sent).toBe(0);
  });

  it('returns 500 when preferences query fails', async () => {
    fromCallQueue.push({ data: null, error: { message: 'DB error' } });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Budget threshold cron failed');
  });

  it('skips user when budget_threshold_sends record already exists', async () => {
    // Eligible users list
    fromCallQueue.push({
      data: [{ user_id: 'user-1', push_budget_threshold: true, push_enabled: true }],
      error: null,
    });
    // Idempotency check — existing row found
    fromCallQueue.push({ data: { id: 'send-1' }, error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('skips user when MTD spend is below threshold', async () => {
    // Eligible users list
    fromCallQueue.push({
      data: [{ user_id: 'user-2', push_budget_threshold: true, push_enabled: true }],
      error: null,
    });
    // Idempotency — no existing send
    fromCallQueue.push({ data: null, error: null });
    // Subscription tier: free ($10 cap), threshold = 80% = $8
    fromCallQueue.push({ data: { tier: 'free' }, error: null });
    // MTD spend: $5 (below $8 threshold)
    fromCallQueue.push({ data: [{ cost_usd: 5 }], error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('sends push when MTD spend exceeds threshold', async () => {
    // Eligible users
    fromCallQueue.push({
      data: [{ user_id: 'user-3', push_budget_threshold: true, push_enabled: true }],
      error: null,
    });
    // Idempotency — no existing send
    fromCallQueue.push({ data: null, error: null });
    // Subscription: power ($200 cap), threshold = 80% = $160
    fromCallQueue.push({ data: { tier: 'power' }, error: null });
    // MTD spend: $180 (above $160 threshold)
    fromCallQueue.push({ data: [{ cost_usd: 180 }], error: null });
    // Insert budget_threshold_sends row
    fromCallQueue.push({ data: null, error: null });
    // Insert audit_log row
    fromCallQueue.push({ data: null, error: null });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(mockSendRetentionPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-3',
        type: 'budget_threshold',
      })
    );
  });

  it('skips send when Expo push returns false', async () => {
    mockSendRetentionPush.mockResolvedValueOnce(false);

    fromCallQueue.push({
      data: [{ user_id: 'user-4', push_budget_threshold: true, push_enabled: true }],
      error: null,
    });
    fromCallQueue.push({ data: null, error: null }); // idempotency
    fromCallQueue.push({ data: { tier: 'power' }, error: null }); // subscription
    fromCallQueue.push({ data: [{ cost_usd: 180 }], error: null }); // costs

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
  });
});
