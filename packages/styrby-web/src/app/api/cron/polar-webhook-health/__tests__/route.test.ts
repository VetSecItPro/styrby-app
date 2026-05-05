/**
 * Tests for GET /api/cron/polar-webhook-health
 *
 * Coverage matrix:
 *   - 401 on missing/wrong cron secret
 *   - happy path: events recent + clean dedup => no alert, single check audit row
 *   - no-events alert: latest event > 4h ago AND business-hours window =>
 *     email + alert + check audit rows
 *   - dedup-error spike alert: > 5% guard-error rate over 24h => email + audit
 *   - throttled: prior alert for same signal in last 24h => no email
 *   - hard 24h-old alert: latest event > 24h ago => fires even at night
 *   - supabase failure: 500 + check audit row noting query errors
 *   - pure helpers: evaluateHealth signal logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---- Mocks ----------------------------------------------------------------

const mockSendEmail = vi.fn();
vi.mock('@/lib/resend', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

vi.mock('@/emails/polar-webhook-health-alert', () => ({
  default: vi.fn((props: unknown) => ({ __template: 'polar-webhook-health-alert', props })),
}));

// audit_log insert spy
const auditInserts: Array<Record<string, unknown>> = [];

// per-table query result fixtures (mutated per test)
interface TableResults {
  // polar_webhook_events.order().limit() — latest event row
  latestEvent: { processed_at: string } | null;
  // polar_webhook_events count over last 24h
  eventCount24h: number;
  // audit_log count of guard-error actions over 24h
  guardErrorCount24h: number;
  // recent event types (last 10 rows)
  recentEventTypes: Array<{ event_type: string }>;
  // throttle lookup: prior polar_webhook_health_alert rows
  recentAlerts: Array<{ created_at: string; metadata: { signal: string } }>;
  // simulate failure on initial queries
  failQueries: boolean;
}

let results: TableResults;

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const failError = { message: 'connection refused' };
      const eventsChain: Record<string, unknown> = {};
      eventsChain['select'] = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact' && opts?.head) {
          // count-only query
          if (table === 'polar_webhook_events') {
            const c = eventsChain;
            c['gte'] = vi.fn(() =>
              Promise.resolve(
                results.failQueries
                  ? { count: null, error: failError }
                  : { count: results.eventCount24h, error: null }
              )
            );
            return c;
          }
          if (table === 'audit_log') {
            const c = eventsChain;
            c['in'] = vi.fn(() => c);
            c['gte'] = vi.fn(() =>
              Promise.resolve(
                results.failQueries
                  ? { count: null, error: failError }
                  : { count: results.guardErrorCount24h, error: null }
              )
            );
            return c;
          }
        }
        // chained query: order/limit
        const c = eventsChain;
        c['order'] = vi.fn(() => c);
        c['limit'] = vi.fn((n: number) => {
          if (results.failQueries) {
            return Promise.resolve({ data: null, error: failError });
          }
          if (table === 'polar_webhook_events' && n === 1) {
            return Promise.resolve({
              data: results.latestEvent ? [results.latestEvent] : [],
              error: null,
            });
          }
          if (table === 'polar_webhook_events' && n === 10) {
            return Promise.resolve({
              data: results.recentEventTypes,
              error: null,
            });
          }
          if (table === 'audit_log') {
            // throttle lookup chain (eq → gte → order → limit)
            return Promise.resolve({
              data: results.recentAlerts,
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        });
        c['eq'] = vi.fn(() => c);
        c['gte'] = vi.fn(() => c);
        c['in'] = vi.fn(() => c);
        return c;
      });
      eventsChain['insert'] = vi.fn((row: Record<string, unknown>) => {
        auditInserts.push(row);
        return Promise.resolve({ data: null, error: null });
      });
      return eventsChain;
    },
  }),
}));

// Import handler AFTER mocks
import { GET } from '../route';
import { evaluateHealth, formatHours, isBusinessHourCentral } from '../lib';

const CRON_SECRET = 'test-cron-secret';

function makeRequest(secret: string = CRON_SECRET): NextRequest {
  return new NextRequest('https://example.com/api/cron/polar-webhook-health', {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auditInserts.length = 0;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.POLAR_WEBHOOK_ALERT_EMAIL = 'alerts@example.com';
  results = {
    latestEvent: { processed_at: new Date().toISOString() },
    eventCount24h: 50,
    guardErrorCount24h: 0,
    recentEventTypes: [
      { event_type: 'subscription.updated' },
      { event_type: 'subscription.created' },
      { event_type: 'subscription.updated' },
    ],
    recentAlerts: [],
    failQueries: false,
  };
  mockSendEmail.mockResolvedValue({ success: true, id: 'email-1' });
});

// ---- Pure-helper tests ----------------------------------------------------

describe('evaluateHealth', () => {
  // Pick a known business-hours instant: noon Central. May 5, 2026 at 17:00 UTC = 12:00 CDT.
  const businessHoursNow = new Date(Date.UTC(2026, 4, 5, 17, 0, 0));
  // Pick a known overnight instant: 09:00 UTC = 04:00 CDT.
  const overnightNow = new Date(Date.UTC(2026, 4, 5, 9, 0, 0));

  it('happy path: recent events, low error rate => no signals tripped', () => {
    const evals = evaluateHealth({
      now: businessHoursNow,
      latestEventAt: new Date(businessHoursNow.getTime() - 30 * 60 * 1000),
      eventCount24h: 100,
      guardErrorCount24h: 1,
    });
    expect(evals.every((e) => !e.tripped)).toBe(true);
  });

  it('no-events-business-hours trips when last event > 4h during business hours', () => {
    const evals = evaluateHealth({
      now: businessHoursNow,
      latestEventAt: new Date(businessHoursNow.getTime() - 5 * 60 * 60 * 1000),
      eventCount24h: 2,
      guardErrorCount24h: 0,
    });
    const noEv = evals.find((e) => e.signal === 'no_events_business_hours')!;
    expect(noEv.tripped).toBe(true);
  });

  it('no-events-business-hours does NOT trip overnight even if > 4h silence', () => {
    const evals = evaluateHealth({
      now: overnightNow,
      latestEventAt: new Date(overnightNow.getTime() - 6 * 60 * 60 * 1000),
      eventCount24h: 2,
      guardErrorCount24h: 0,
    });
    const noEv = evals.find((e) => e.signal === 'no_events_business_hours')!;
    expect(noEv.tripped).toBe(false);
  });

  it('dedup_error_spike trips when guard rate > 5%', () => {
    const evals = evaluateHealth({
      now: businessHoursNow,
      latestEventAt: new Date(businessHoursNow.getTime() - 30 * 60 * 1000),
      eventCount24h: 100,
      guardErrorCount24h: 10, // 10%
    });
    const spike = evals.find((e) => e.signal === 'dedup_error_spike')!;
    expect(spike.tripped).toBe(true);
  });

  it('latest_event_24h_old trips when last event > 24h regardless of hour', () => {
    const evals = evaluateHealth({
      now: overnightNow,
      latestEventAt: new Date(overnightNow.getTime() - 30 * 60 * 60 * 1000),
      eventCount24h: 0,
      guardErrorCount24h: 0,
    });
    const hard = evals.find((e) => e.signal === 'latest_event_24h_old')!;
    expect(hard.tripped).toBe(true);
  });
});

describe('formatHours', () => {
  it('formats sub-hour as minutes, hours with one decimal, infinity as never', () => {
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(3.42)).toBe('3.4h');
    expect(formatHours(Infinity)).toBe('never');
  });
});

describe('isBusinessHourCentral', () => {
  it('returns true for noon CDT (17:00 UTC in May)', () => {
    expect(isBusinessHourCentral(new Date(Date.UTC(2026, 4, 5, 17, 0, 0)))).toBe(true);
  });
  it('returns false for 4 AM CDT (09:00 UTC in May)', () => {
    expect(isBusinessHourCentral(new Date(Date.UTC(2026, 4, 5, 9, 0, 0)))).toBe(false);
  });
});

// ---- Route tests ----------------------------------------------------------

describe('GET /api/cron/polar-webhook-health', () => {
  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(makeRequest('wrong-secret-xxxxx'));
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('happy path: recent events + clean dedup => no alert, one check audit row', async () => {
    results.latestEvent = {
      processed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };
    results.eventCount24h = 50;
    results.guardErrorCount24h = 0;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_count_24h).toBe(50);
    expect(body.guard_error_count_24h).toBe(0);
    expect(body.signals.every((s: { alerted: boolean }) => !s.alerted)).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].action).toBe('polar_webhook_health_check');
    const meta = auditInserts[0].metadata as Record<string, unknown>;
    expect(meta.ok).toBe(true);
  });

  it('hard 24h-old alert: dispatches email + writes alert + check audit rows', async () => {
    // 30h ago — trips latest_event_24h_old regardless of business-hour gate.
    results.latestEvent = {
      processed_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    };
    results.eventCount24h = 0;
    results.guardErrorCount24h = 0;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    const hardSignal = body.signals.find(
      (s: { signal: string }) => s.signal === 'latest_event_24h_old'
    );
    expect(hardSignal.tripped).toBe(true);
    expect(hardSignal.alerted).toBe(true);

    // Note: 30h-old + business-hours run also trips no_events_business_hours,
    // so we expect AT LEAST one alert containing the hard-threshold subject.
    // (If the test happens to run overnight Central, only the hard signal
    // trips; either way the hard signal must alert.)
    expect(mockSendEmail).toHaveBeenCalled();
    const subjects = mockSendEmail.mock.calls.map((c) => c[0].subject);
    expect(
      subjects.some(
        (s: string) =>
          s.includes('[Styrby Polar webhook]') &&
          s.includes('latest event > 24h old')
      )
    ).toBe(true);

    // Audit rows: at least one alert for the hard signal + one check.
    const actions = auditInserts.map((r) => r.action);
    expect(actions).toContain('polar_webhook_health_alert');
    expect(actions).toContain('polar_webhook_health_check');
    const hardAlertRow = auditInserts.find(
      (r) =>
        r.action === 'polar_webhook_health_alert' &&
        (r.metadata as { signal?: string }).signal === 'latest_event_24h_old'
    );
    expect(hardAlertRow).toBeTruthy();
  });

  it('dedup-error spike alert: 10% guard rate over 24h dispatches email', async () => {
    results.latestEvent = {
      processed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };
    results.eventCount24h = 100;
    results.guardErrorCount24h = 10;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const emailArgs = mockSendEmail.mock.calls[0][0];
    expect(emailArgs.subject).toContain('guard-error spike');
    const alertRow = auditInserts.find(
      (r) => r.action === 'polar_webhook_health_alert'
    )!;
    const alertMeta = alertRow.metadata as Record<string, unknown>;
    expect(alertMeta.signal).toBe('dedup_error_spike');
    expect(alertMeta.guard_error_rate_pct).toBe(10);
  });

  it('throttled: prior alert for same signal in last 24h => no email', async () => {
    results.latestEvent = {
      processed_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    };
    results.eventCount24h = 0;
    results.guardErrorCount24h = 0;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Throttle ALL signals that could trip (during business hours both
    // no_events_business_hours and latest_event_24h_old fire on a 30h gap).
    results.recentAlerts = [
      { created_at: oneHourAgo, metadata: { signal: 'latest_event_24h_old' } },
      { created_at: oneHourAgo, metadata: { signal: 'no_events_business_hours' } },
    ];

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    const body = await res.json();
    const hardSignal = body.signals.find(
      (s: { signal: string }) => s.signal === 'latest_event_24h_old'
    );
    expect(hardSignal.tripped).toBe(true);
    expect(hardSignal.alerted).toBe(false);
    expect(hardSignal.last_alert_at).toBe(oneHourAgo);
    // Only the check row should be written (no alert row).
    const actions = auditInserts.map((r) => r.action);
    expect(actions).not.toContain('polar_webhook_health_alert');
    expect(actions).toContain('polar_webhook_health_check');
  });

  it('supabase failure: 500 + check audit row noting query errors', async () => {
    results.failQueries = true;

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    const meta = auditInserts[0].metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
  });
});
