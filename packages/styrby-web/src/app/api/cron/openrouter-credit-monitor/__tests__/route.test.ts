/**
 * Tests for GET /api/cron/openrouter-credit-monitor
 *
 * Coverage matrix:
 *   - 401 on missing/wrong cron secret
 *   - happy path: balance above threshold, no alert, audit row written with cap metrics
 *   - alert path: balance below threshold + no recent alert, email + 2 audit rows;
 *                 subject contains the new "[Styrby OpenRouter] $X.XX remaining (Y%
 *                 of $50/mo cap used) - N days left in cycle" format
 *   - throttled path: balance below threshold + recent alert, no email
 *   - /credits API failure: 502 + audit row noting which endpoint
 *   - /auth/key API failure: 502 + audit row noting which endpoint
 *   - uncapped key: limit=null falls back to lifetime remaining for the
 *                   alert decision; no projection blow-up
 *   - computeCycleMetrics: pure-function correctness for cap/burn/projection
 *   - formatCentralTimestamp: contains "CDT" or "CST" (deterministic tz)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ----------------------------------------------------------------------------
// Mocks (must be set up before importing the route)
// ----------------------------------------------------------------------------

const mockSendEmail = vi.fn();
vi.mock('@/lib/resend', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

// audit_log insert spy
const auditInserts: Array<Record<string, unknown>> = [];

// recent alert query result (for throttle check)
let recentAlertResult: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'audit_log') {
        throw new Error(`unexpected table: ${table}`);
      }
      const chain: Record<string, unknown> = {};
      chain['select'] = vi.fn(() => chain);
      chain['eq'] = vi.fn(() => chain);
      chain['gte'] = vi.fn(() => chain);
      chain['order'] = vi.fn(() => chain);
      chain['limit'] = vi.fn(() => Promise.resolve(recentAlertResult));
      chain['insert'] = vi.fn((row: Record<string, unknown>) => {
        auditInserts.push(row);
        return Promise.resolve({ data: null, error: null });
      });
      return chain;
    },
  }),
}));

// Stub the email template module — the template renders fine in isolation
// but pulling React Email into vitest noticeably slows the suite and adds
// nothing the route's own tests need to assert (template rendering has its
// own snapshot coverage path if/when added).
vi.mock('@/emails/openrouter-credit-alert', () => ({
  default: vi.fn((props: unknown) => ({ __template: 'openrouter-credit-alert', props })),
}));

// Import handler AFTER mocks
import { GET } from '../route';
import { computeCycleMetrics, formatCentralTimestamp } from '../cycle-metrics';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const CRON_SECRET = 'test-cron-secret';

function makeRequest(secret: string = CRON_SECRET): NextRequest {
  return new NextRequest(
    'https://example.com/api/cron/openrouter-credit-monitor',
    { method: 'GET', headers: { authorization: `Bearer ${secret}` } }
  );
}

interface MockEndpointConfig {
  ok: boolean;
  status?: number;
  body?: unknown;
  bodyText?: string;
}

/**
 * Mock both /credits and /auth/key endpoints. Keyed by URL substring so
 * the route's Promise.all gets a deterministic match per call.
 */
function mockOpenRouter(
  credits: MockEndpointConfig,
  authKey: MockEndpointConfig
) {
  global.fetch = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    const cfg = url.includes('/auth/key') ? authKey : credits;
    return Promise.resolve({
      ok: cfg.ok,
      status: cfg.status ?? (cfg.ok ? 200 : 500),
      json: () => Promise.resolve(cfg.body ?? null),
      text: () => Promise.resolve(cfg.bodyText ?? ''),
    });
  }) as unknown as typeof global.fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditInserts.length = 0;
  recentAlertResult = { data: [], error: null };
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.OPENROUTER_LOW_BALANCE_THRESHOLD = '20';
  process.env.OPENROUTER_ALERT_EMAIL = 'alerts@example.com';
  mockSendEmail.mockResolvedValue({ success: true, id: 'email-1' });
});

// ----------------------------------------------------------------------------
// Pure-helper tests (no env / no fetch needed)
// ----------------------------------------------------------------------------

describe('computeCycleMetrics', () => {
  it('mid-month, on-track: cap=50, used=10 (cycle), monthly=10, day 10/31', () => {
    const now = new Date(Date.UTC(2026, 4, 10, 12, 0, 0)); // May 10, 2026 UTC
    const m = computeCycleMetrics(now, 50, 40, 10);
    expect(m.capUsd).toBe(50);
    expect(m.remainingUsd).toBe(40);
    expect(m.usedThisCycleUsd).toBe(10);
    expect(m.capPctUsed).toBeCloseTo(20, 5);
    expect(m.daysIntoCycle).toBe(10);
    expect(m.daysRemainingInCycle).toBe(21); // 31 - 10
    expect(m.dailyBurnUsd).toBeCloseTo(1, 5);
    expect(m.projectedEndOfCycleUsd).toBeCloseTo(31, 5);
    expect(m.projectedOverageUsd).toBe(0);
    expect(m.nextResetIso).toBe('2026-06-01T00:00:00.000Z');
    expect(m.nextResetLabel).toMatch(/Monday, June 1, 2026/);
  });

  it('flags overage when projection exceeds cap', () => {
    const now = new Date(Date.UTC(2026, 4, 15, 0, 0, 0)); // May 15
    // burn $5/day × 31 days = $155, cap $50 → overage $105
    const m = computeCycleMetrics(now, 50, -25, 75);
    expect(m.usedThisCycleUsd).toBe(75); // 50 - (-25)
    expect(m.dailyBurnUsd).toBeCloseTo(5, 5);
    expect(m.projectedEndOfCycleUsd).toBeCloseTo(155, 5);
    expect(m.projectedOverageUsd).toBeCloseTo(105, 5);
    expect(m.capPctUsed).toBeGreaterThan(100);
  });

  it('handles uncapped key (cap=0) without dividing by zero or asserting overage', () => {
    const now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0)); // May 1, day 1
    const m = computeCycleMetrics(now, 0, 100, 0);
    expect(m.capPctUsed).toBe(0);
    expect(m.projectedOverageUsd).toBe(0);
    expect(m.dailyBurnUsd).toBe(0);
    expect(m.daysIntoCycle).toBe(1); // floored to ≥ 1 to avoid /0
  });

  it('last-day-of-month: daysRemainingInCycle clamps to 0', () => {
    const now = new Date(Date.UTC(2026, 4, 31, 23, 59, 0)); // May 31
    const m = computeCycleMetrics(now, 50, 5, 45);
    expect(m.daysRemainingInCycle).toBe(0);
    expect(m.daysIntoCycle).toBe(31);
  });
});

describe('formatCentralTimestamp', () => {
  it('renders a Central-tz string with day + time + tz code', () => {
    const out = formatCentralTimestamp(new Date(Date.UTC(2026, 4, 10, 12, 0, 0)));
    // Allow CDT (May = DST) or CST (defensive); just guarantee a tz code is appended.
    expect(out).toMatch(/C[DS]T/);
    expect(out).toContain('2026');
  });
});

// ----------------------------------------------------------------------------
// Route tests
// ----------------------------------------------------------------------------

describe('GET /api/cron/openrouter-credit-monitor', () => {
  it('returns 401 when CRON_SECRET does not match', async () => {
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 0 } } },
      { ok: true, body: { data: { limit: 50, limit_remaining: 40, usage_monthly: 10 } } }
    );
    const res = await GET(makeRequest('wrong-secret-xxxxx'));
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('happy path: balance above threshold, records check with cap metrics, no alert', async () => {
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 25 } } },
      {
        ok: true,
        body: {
          data: {
            limit: 50,
            limit_remaining: 35,
            usage_monthly: 15,
            usage_weekly: 7,
            usage_daily: 1,
          },
        },
      }
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remaining).toBe(35); // limit_remaining wins over lifetime
    expect(body.threshold).toBe(20);
    expect(body.alerted).toBe(false);
    expect(body.cap).toBe(50);
    expect(body.cap_pct_used).toBeCloseTo(30, 1); // (50-35)/50 = 30%
    expect(mockSendEmail).not.toHaveBeenCalled();

    // Exactly one credit_check audit row, no alert row.
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].action).toBe('openrouter_credit_check');
    const meta = auditInserts[0].metadata as Record<string, unknown>;
    expect(meta.alerted).toBe(false);
    expect(meta.cap).toBe(50);
    expect(meta.usage_monthly).toBe(15);
    expect(meta.usage_weekly).toBe(7);
    expect(meta.usage_daily).toBe(1);
  });

  it('alert path: below threshold sends rich email with new subject + writes both audit rows', async () => {
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 95 } } },
      {
        ok: true,
        body: {
          data: {
            limit: 50,
            limit_remaining: 5,
            usage_monthly: 45,
            usage_weekly: 12,
            usage_daily: 2,
          },
        },
      }
    );
    recentAlertResult = { data: [], error: null };

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remaining).toBe(5);
    expect(body.alerted).toBe(true);
    expect(body.last_alert_at).toBeTruthy();
    expect(body.cap).toBe(50);
    expect(body.days_remaining_in_cycle).toBeGreaterThanOrEqual(0);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const emailArgs = mockSendEmail.mock.calls[0][0];
    expect(emailArgs.to).toBe('alerts@example.com');
    // New subject format: prefix tag + remaining + cap pct + days left.
    expect(emailArgs.subject).toContain('[Styrby OpenRouter]');
    expect(emailArgs.subject).toContain('$5.00 remaining');
    expect(emailArgs.subject).toContain('% of $50.00/mo cap used');
    expect(emailArgs.subject).toContain('days left in cycle');

    // Both audit rows: alert row (with rich metadata) + credit_check row.
    expect(auditInserts).toHaveLength(2);
    const actions = auditInserts.map((r) => r.action);
    expect(actions).toContain('openrouter_low_balance_alert');
    expect(actions).toContain('openrouter_credit_check');
    const alertRow = auditInserts.find(
      (r) => r.action === 'openrouter_low_balance_alert'
    )!;
    const alertMeta = alertRow.metadata as Record<string, unknown>;
    expect(alertMeta.cap).toBe(50);
    expect(alertMeta.key_label).toBe('Styrby Production v2');
    expect(alertMeta.cap_pct_used).toBeGreaterThan(0);
    expect(alertMeta.daily_burn).toBeGreaterThan(0);
  });

  it('throttled path: recent alert exists, skips email, still records check', async () => {
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 95 } } },
      { ok: true, body: { data: { limit: 50, limit_remaining: 5, usage_monthly: 45 } } }
    );
    const lastAlertIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    recentAlertResult = { data: [{ created_at: lastAlertIso }], error: null };

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerted).toBe(false);
    expect(body.last_alert_at).toBe(lastAlertIso);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].action).toBe('openrouter_credit_check');
  });

  it('/credits failure: continues with /auth/key data only (200, not 502)', async () => {
    // CONTRACT (updated 2026-05-05): /credits requires a "management"
    // (provisioning) key. The runtime OPENROUTER_API_KEY in env is
    // forbidden from /credits with 403 'Only management keys can fetch
    // credits'. The cap-based alert decision uses /auth/key data only,
    // so /credits failure is logged + skipped, NOT fatal.
    mockOpenRouter(
      { ok: false, status: 403, bodyText: 'Only management keys can fetch credits' },
      { ok: true, body: { data: { limit: 50, limit_remaining: 40, usage_monthly: 10 } } }
    );

    const res = await GET(makeRequest());
    // Above threshold ($40 remaining, default $20 threshold) → no alert,
    // happy 200 with check audit row only.
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    const meta = auditInserts[0].metadata as Record<string, unknown>;
    expect(meta.ok).toBe(true);
    expect(meta.endpoint).toBeUndefined(); // no failure endpoint tagged
  });

  it('/auth/key failure: returns 502 and audit row tags endpoint=auth/key', async () => {
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 25 } } },
      { ok: false, status: 500, bodyText: 'internal' }
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(502);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    const meta = auditInserts[0].metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(meta.endpoint).toBe('auth/key');
  });

  it('uncapped key (limit=null): falls back to lifetime remaining for alert decision', async () => {
    // Lifetime: 100 credits, 95 used → 5 remaining (below $20 threshold).
    // No per-key cap → cap=0, projections suppressed.
    mockOpenRouter(
      { ok: true, body: { data: { total_credits: 100, total_usage: 95 } } },
      {
        ok: true,
        body: {
          data: {
            limit: null,
            limit_remaining: null,
            usage_monthly: 0,
            usage_weekly: 0,
            usage_daily: 0,
          },
        },
      }
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remaining).toBe(5);
    expect(body.cap).toBe(0);
    expect(body.alerted).toBe(true);
    expect(body.projected_overage).toBe(0); // no cap → no overage
  });
});
