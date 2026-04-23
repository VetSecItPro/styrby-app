/**
 * Unit tests for POST /api/cron/predictive-cost-alerts
 *
 * WHY: This cron route sends push notifications about predicted quota
 * exhaustion. Bugs here produce: false alerts (users warned when not near cap),
 * missed alerts (users who should be warned are silently skipped), or alert
 * floods (idempotency check failure sending 7 pushes in 7 nights).
 *
 * @module api/cron/predictive-cost-alerts/__tests__/route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const MOCK_CRON_SECRET = 'test-cron-secret-abc';

vi.stubEnv('CRON_SECRET', MOCK_CRON_SECRET);
vi.stubEnv('NODE_ENV', 'test');

/** Sequential queue for Supabase .from() responses */
const fromCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: [], error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'order', 'limit', 'insert', 'maybeSingle',
    'not', 'filter',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

const mockAdminFrom = vi.fn(() => createChainMock());

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
    auth: { admin: {} },
  })),
}));

const mockSendRetentionPush = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/pushNotifications', () => ({
  sendRetentionPush: mockSendRetentionPush,
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { POST } from '../route.js';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(secret = MOCK_CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/predictive-cost-alerts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    body: '{}',
  });
}

function makeRow(dateIso: string, costUsd: number) {
  return { recorded_at: `${dateIso}T12:00:00.000Z`, cost_usd: costUsd };
}

/**
 * Seeds the from() queue for a typical single-user run.
 *
 * Order of calls in the cron handler:
 *   1. notification_preferences (users list)
 *   2. predictive_cost_alert_sends (idempotency check)
 *   3. subscriptions (tier)
 *   4. cost_records (history)
 *   5. (pushSent = true) → predictive_cost_alert_sends (insert)
 *   6. audit_log (insert)
 */
function seedSingleUser(opts: {
  users?: unknown[];
  existingSend?: unknown;
  tier?: string;
  costRows?: { recorded_at: string; cost_usd: number }[];
  pushSent?: boolean;
  quotaCents?: number | null;
}) {
  const {
    users = [
      {
        user_id: 'user-001',
        push_predictive_alert: true,
        push_enabled: true,
        quiet_hours_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: null,
      },
    ],
    existingSend = null,
    tier = 'pro',
    costRows = [],
    pushSent = true,
  } = opts;

  fromCallQueue.length = 0;
  fromCallQueue.push({ data: users, error: null });           // 1. notification_preferences
  fromCallQueue.push({ data: existingSend, error: null });    // 2. idempotency check
  fromCallQueue.push({ data: tier ? { tier } : null, error: null }); // 3. subscriptions
  fromCallQueue.push({ data: costRows, error: null });        // 4. cost_records
  fromCallQueue.push({ data: null, error: null });            // 5. insert send record
  fromCallQueue.push({ data: null, error: null });            // 6. audit_log

  mockSendRetentionPush.mockResolvedValue(pushSent);
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/predictive-cost-alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 with wrong cron secret', async () => {
    const response = await POST(makeRequest('wrong-secret'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with missing authorization header', async () => {
    const req = new NextRequest('http://localhost/api/cron/predictive-cost-alerts', {
      method: 'POST',
      body: '{}',
    });
    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // No users case
  // -------------------------------------------------------------------------

  it('returns 200 with zero counts when no eligible users', async () => {
    fromCallQueue.push({ data: [], error: null });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, checked: 0, sent: 0, skipped: 0 });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('skips user who already received an alert this billing period', async () => {
    const users = [
      {
        user_id: 'user-001',
        push_predictive_alert: true,
        push_enabled: true,
        quiet_hours_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: null,
      },
    ];

    fromCallQueue.push({ data: users, error: null });         // users list
    fromCallQueue.push({ data: { id: 'existing-send' }, error: null }); // existing send

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.checked).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Uncapped tier skipping
  // -------------------------------------------------------------------------

  it('skips Power tier users (null quota, no exhaustion possible)', async () => {
    const users = [
      {
        user_id: 'user-power',
        push_predictive_alert: true,
        push_enabled: true,
        quiet_hours_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: null,
      },
    ];

    fromCallQueue.push({ data: users, error: null });        // users
    fromCallQueue.push({ data: null, error: null });         // no existing send
    fromCallQueue.push({ data: { tier: 'power' }, error: null }); // subscription

    const response = await POST(makeRequest());
    const body = await response.json();
    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Threshold behavior: within window vs. outside window
  // -------------------------------------------------------------------------

  it('sends alert when exhaustion is predicted within 7 days', async () => {
    // Pro quota = $50 = 5000 cents. Burn $10/day = 1000 cents/day.
    // Elapsed = $30 = 3000 cents. Remaining = 2000 cents. Days = 2.
    const costRows = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 22 + i));
      return makeRow(d.toISOString().slice(0, 10), 10.0);
    });

    seedSingleUser({ costRows, tier: 'pro', pushSent: true });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(0);
    expect(mockSendRetentionPush).toHaveBeenCalledOnce();

    const pushCall = mockSendRetentionPush.mock.calls[0][0];
    expect(pushCall.title).toBe('Spending Cap Approaching');
    expect(pushCall.body).toContain('cap on');
  });

  it('skips alert when exhaustion is predicted beyond 7 days', async () => {
    // Pro quota = 5000 cents. Burn $0.05/day = 5 cents/day.
    // Elapsed = 0. Days until exhaustion = 5000/5 = 1000 days — outside window.
    const costRows = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 22 + i));
      return makeRow(d.toISOString().slice(0, 10), 0.05);
    });

    seedSingleUser({ costRows, tier: 'pro' });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  it('skips alert when user has zero spend (no exhaustion predicted)', async () => {
    seedSingleUser({ costRows: [], tier: 'pro' });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockSendRetentionPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Opt-out via quiet hours / no push token
  // -------------------------------------------------------------------------

  it('counts as skipped when push is suppressed (quiet hours)', async () => {
    // High burn rate → exhaustion within 7 days
    const costRows = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 22 + i));
      return makeRow(d.toISOString().slice(0, 10), 10.0);
    });

    // Push returns false → quiet hours suppressed the notification
    seedSingleUser({ costRows, tier: 'pro', pushSent: false });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    // Should NOT insert idempotency record since push was suppressed
    expect(mockSendRetentionPush).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns 500 when notification_preferences query fails', async () => {
    fromCallQueue.push({ data: null, error: { message: 'Connection lost' } });

    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Predictive cost alert cron failed');
  });
});
