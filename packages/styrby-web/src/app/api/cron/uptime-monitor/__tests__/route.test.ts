/**
 * Tests for GET /api/cron/uptime-monitor
 *
 * Coverage matrix:
 *   - 401 on wrong CRON_SECRET
 *   - happy path: all URLs return 200, no alerts, audit_log gets uptime_check rows
 *   - single failure: no alert email yet (below threshold), state increments
 *   - two consecutive failures: alert email + uptime_alert audit row
 *   - third failure within throttle window: no second alert
 *   - recovery: previously alerting URL returns 200, recovery email + audit row
 *   - state upsert resets BOTH alert_sent_at + recovery_sent_at on recovery
 *     (regression test for 2026-05-05 noise incident — see new test below)
 *   - decideAction pure-helper correctness
 *   - parseUrlList: defaults + CSV parsing + bad input filtered
 *   - formatDuration: short + long ranges
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockSendEmail = vi.fn();
vi.mock('@/lib/resend', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

interface FakeRow {
  url: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  alert_sent_at: string | null;
  recovery_sent_at: string | null;
  consecutive_failures: number;
  last_status_code: number | null;
  last_error: string | null;
}

const auditInserts: Array<Record<string, unknown>> = [];
const upserts: Array<Record<string, unknown>> = [];
let priorRows: FakeRow[] = [];

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'audit_log') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            auditInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }
      if (table === 'uptime_alerts') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => Promise.resolve({ data: priorRows, error: null })),
          })),
          upsert: vi.fn((row: Record<string, unknown>) => {
            upserts.push(row);
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

// Stub email templates — they render fine standalone but pulling the
// React Email layout into vitest is slow and adds nothing the route
// tests need to assert.
vi.mock('@/emails/uptime-alert', () => ({
  default: vi.fn((props: unknown) => ({ __template: 'uptime-alert', props })),
}));
vi.mock('@/emails/uptime-recovery', () => ({
  default: vi.fn((props: unknown) => ({ __template: 'uptime-recovery', props })),
}));

import { GET } from '../route';
import {
  decideAction,
  formatDuration,
  parseUrlList,
  DEFAULT_UPTIME_URLS,
} from '../lib';

const CRON_SECRET = 'test-cron-secret';

function makeRequest(secret: string = CRON_SECRET): NextRequest {
  return new NextRequest(
    'https://example.com/api/cron/uptime-monitor',
    { method: 'GET', headers: { authorization: `Bearer ${secret}` } }
  );
}

/** Mock global fetch to return the same status for every URL. */
function mockAllUrls(
  status: number,
  body: unknown = null,
  shouldThrow = false
) {
  global.fetch = vi.fn(() => {
    if (shouldThrow) return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
    });
  }) as unknown as typeof global.fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditInserts.length = 0;
  upserts.length = 0;
  priorRows = [];
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.UPTIME_ALERT_EMAIL = 'alerts@example.com';
  process.env.UPTIME_CHECK_URLS = 'https://www.styrbyapp.com,https://www.styrbyapp.com/api/health';
  mockSendEmail.mockResolvedValue({ success: true, id: 'email-1' });
});

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

describe('parseUrlList', () => {
  it('returns defaults on undefined', () => {
    expect(parseUrlList(undefined)).toEqual(DEFAULT_UPTIME_URLS);
  });
  it('parses CSV', () => {
    const parsed = parseUrlList('https://a.com, https://b.com');
    expect(parsed).toEqual(['https://a.com', 'https://b.com']);
  });
  it('filters out non-http entries', () => {
    const parsed = parseUrlList('https://a.com, not-a-url, javascript:alert(1)');
    expect(parsed).toEqual(['https://a.com']);
  });
  it('falls back to defaults when nothing parses', () => {
    expect(parseUrlList('garbage,more garbage')).toEqual(DEFAULT_UPTIME_URLS);
  });
});

describe('formatDuration', () => {
  it('seconds', () => expect(formatDuration(15_000)).toBe('15s'));
  it('minutes', () => expect(formatDuration(12 * 60_000)).toBe('12m'));
  it('hours and minutes', () =>
    expect(formatDuration(2 * 60 * 60_000 + 14 * 60_000)).toBe('2h 14m'));
  it('whole hours', () => expect(formatDuration(3 * 60 * 60_000)).toBe('3h'));
});

describe('decideAction', () => {
  const now = new Date('2026-05-05T12:00:00Z');
  const okPing = {
    url: 'u',
    ok: true,
    status: 200,
    duration_ms: 50,
    error: null,
    health_body: null,
  };
  const failPing = { ...okPing, ok: false, status: 503, error: 'HTTP 503' };

  it('healthy + no prior state => none', () => {
    expect(decideAction(okPing, null, now).action).toBe('none');
  });
  it('first failure => none, increments counter', () => {
    const r = decideAction(failPing, null, now);
    expect(r.action).toBe('none');
    expect(r.nextConsecutiveFailures).toBe(1);
  });
  it('second failure with no prior alert => alert', () => {
    const prior = {
      url: 'u',
      last_success_at: null,
      last_failure_at: now.toISOString(),
      alert_sent_at: null,
      recovery_sent_at: null,
      consecutive_failures: 1,
      last_status_code: 503,
      last_error: null,
    };
    const r = decideAction(failPing, prior, now);
    expect(r.action).toBe('alert');
    expect(r.nextConsecutiveFailures).toBe(2);
  });
  it('throttled: failure within 1h of last alert => none', () => {
    const prior = {
      url: 'u',
      last_success_at: null,
      last_failure_at: now.toISOString(),
      alert_sent_at: new Date(now.getTime() - 30 * 60_000).toISOString(),
      recovery_sent_at: null,
      consecutive_failures: 5,
      last_status_code: 503,
      last_error: null,
    };
    expect(decideAction(failPing, prior, now).action).toBe('none');
  });
  it('recovery: ok ping after alert with no recovery sent => recover', () => {
    const prior = {
      url: 'u',
      last_success_at: null,
      last_failure_at: now.toISOString(),
      alert_sent_at: new Date(now.getTime() - 60 * 60_000).toISOString(),
      recovery_sent_at: null,
      consecutive_failures: 5,
      last_status_code: 503,
      last_error: null,
    };
    const r = decideAction(okPing, prior, now);
    expect(r.action).toBe('recover');
    expect(r.nextConsecutiveFailures).toBe(0);
  });
  it('healthy after recovery already sent => none', () => {
    const recoveredAt = new Date(now.getTime() - 10 * 60_000).toISOString();
    const prior = {
      url: 'u',
      last_success_at: recoveredAt,
      last_failure_at: null,
      alert_sent_at: new Date(now.getTime() - 60 * 60_000).toISOString(),
      recovery_sent_at: recoveredAt,
      consecutive_failures: 0,
      last_status_code: 200,
      last_error: null,
    };
    expect(decideAction(okPing, prior, now).action).toBe('none');
  });
});

// ----------------------------------------------------------------------------
// Route tests
// ----------------------------------------------------------------------------

describe('GET /api/cron/uptime-monitor', () => {
  it('401 when CRON_SECRET wrong', async () => {
    mockAllUrls(200);
    const res = await GET(makeRequest('wrong-secret-padding-len'));
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('happy path: all 200, no alerts, one uptime_check audit row per URL', async () => {
    mockAllUrls(200, { status: 'ok', checks: { db: true, polar: true, openrouter: true } });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts_sent).toBe(0);
    expect(body.recoveries_sent).toBe(0);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();

    // Two audit rows (one per URL), all uptime_check.
    expect(auditInserts).toHaveLength(2);
    expect(auditInserts.every((r) => r.action === 'uptime_check')).toBe(true);
  });

  it('single failure: no alert (below threshold), state row written', async () => {
    mockAllUrls(503);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts_sent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(upserts.length).toBeGreaterThan(0);
    // Each upsert should have consecutive_failures=1
    expect(upserts.every((r) => r.consecutive_failures === 1)).toBe(true);
  });

  it('two consecutive failures: sends alert email + writes uptime_alert audit', async () => {
    // Prior state: each URL already has 1 failure on record.
    priorRows = [
      {
        url: 'https://www.styrbyapp.com',
        last_success_at: '2026-05-05T11:00:00Z',
        last_failure_at: '2026-05-05T11:55:00Z',
        alert_sent_at: null,
        recovery_sent_at: null,
        consecutive_failures: 1,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
      {
        url: 'https://www.styrbyapp.com/api/health',
        last_success_at: '2026-05-05T11:00:00Z',
        last_failure_at: '2026-05-05T11:55:00Z',
        alert_sent_at: null,
        recovery_sent_at: null,
        consecutive_failures: 1,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
    ];
    mockAllUrls(503, { status: 'down', checks: { db: false, polar: true, openrouter: true } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts_sent).toBe(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const subjects = mockSendEmail.mock.calls.map((c) => c[0].subject);
    expect(subjects.every((s: string) => s.includes('[Styrby Uptime]'))).toBe(true);
    expect(subjects.every((s: string) => s.includes('DOWN'))).toBe(true);

    const alertRows = auditInserts.filter((r) => r.action === 'uptime_alert');
    expect(alertRows).toHaveLength(2);
  });

  it('throttled: failure with recent alert_sent_at => no second email', async () => {
    const recentAlert = new Date(Date.now() - 10 * 60_000).toISOString();
    priorRows = [
      {
        url: 'https://www.styrbyapp.com',
        last_success_at: null,
        last_failure_at: recentAlert,
        alert_sent_at: recentAlert,
        recovery_sent_at: null,
        consecutive_failures: 5,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
      {
        url: 'https://www.styrbyapp.com/api/health',
        last_success_at: null,
        last_failure_at: recentAlert,
        alert_sent_at: recentAlert,
        recovery_sent_at: null,
        consecutive_failures: 5,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
    ];
    mockAllUrls(503);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts_sent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // Audit should still contain uptime_check rows.
    expect(auditInserts.filter((r) => r.action === 'uptime_check')).toHaveLength(2);
  });

  it('recovery: previously alerting URL returns 200 => recovery email + audit row', async () => {
    const oldAlert = new Date(Date.now() - 30 * 60_000).toISOString();
    priorRows = [
      {
        url: 'https://www.styrbyapp.com',
        last_success_at: null,
        last_failure_at: oldAlert,
        alert_sent_at: oldAlert,
        recovery_sent_at: null,
        consecutive_failures: 6,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
      {
        url: 'https://www.styrbyapp.com/api/health',
        last_success_at: null,
        last_failure_at: oldAlert,
        alert_sent_at: oldAlert,
        recovery_sent_at: null,
        consecutive_failures: 6,
        last_status_code: 503,
        last_error: 'HTTP 503',
      },
    ];
    mockAllUrls(200, { status: 'ok', checks: { db: true, polar: true, openrouter: true } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recoveries_sent).toBe(2);
    expect(body.alerts_sent).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const subjects = mockSendEmail.mock.calls.map((c) => c[0].subject);
    expect(subjects.every((s: string) => s.includes('RECOVERED'))).toBe(true);

    const recoveryRows = auditInserts.filter((r) => r.action === 'uptime_recovery');
    expect(recoveryRows).toHaveLength(2);

    // State upserts should clear consecutive_failures back to 0.
    expect(upserts.every((r) => r.consecutive_failures === 0)).toBe(true);

    // CRITICAL regression assertion (2026-05-05 noise incident):
    // After firing recovery, BOTH alert_sent_at and recovery_sent_at must
    // be NULL in the upserted row. Otherwise wasAlerting (in decideAction)
    // re-fires on the next healthy tick → infinite recovery-email loop.
    expect(upserts.every((r) => r.alert_sent_at === null)).toBe(true);
    expect(upserts.every((r) => r.recovery_sent_at === null)).toBe(true);
  });

  it('regression (2026-05-05): healthy tick after recovery does NOT re-fire recovery', async () => {
    // Simulate the state RIGHT AFTER a recovery fired in a prior tick:
    // alert_sent_at and recovery_sent_at both null (per the new fix). The
    // URL is healthy. Expectation: no email, no recovery audit row,
    // action_taken = 'none' on the audit_log row.
    priorRows = [
      {
        url: 'https://www.styrbyapp.com/api/health',
        last_success_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_failure_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        alert_sent_at: null,
        recovery_sent_at: null,
        consecutive_failures: 0,
        last_status_code: 200,
        last_error: null,
      },
    ];
    mockAllUrls(200, { status: 'ok', checks: { db: true, polar: true, openrouter: true, resend: true } });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recoveries_sent).toBe(0);
    expect(body.alerts_sent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();

    // The audit row should reflect "no action taken" for the healthy probe.
    const healthChecks = auditInserts.filter((r) => r.action === 'uptime_check');
    expect(healthChecks.length).toBeGreaterThan(0);
    // `metadata` is typed as `unknown` on auditInserts; narrow when reading.
    const healthRow = healthChecks.find((r) => {
      const meta = r.metadata as { url?: string } | undefined;
      return meta?.url === 'https://www.styrbyapp.com/api/health';
    });
    const meta = healthRow?.metadata as { action_taken?: string } | undefined;
    expect(meta?.action_taken).toBe('none');
  });
});
