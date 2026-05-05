/**
 * Tests for GET /api/health
 *
 * Coverage matrix:
 *   - happy path: every dep healthy => 200, status='ok' (db, polar, openrouter, resend)
 *   - db down => 503 status='down'
 *   - polar down => 503 status='degraded'
 *   - openrouter down => 503 status='degraded'
 *   - openrouter unset (e.g. preview env) => skipped (treated healthy)
 *   - resend down (4xx) => 200 status='ok' (informational scope mismatch, warn+continue)
 *   - resend down (5xx) => 503 status='degraded' (real outage)
 *   - resend domains unverified => 503 status='degraded'
 *   - resend unset => skipped (treated healthy)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase admin client mock — toggleable per test.
let dbShouldFail = false;
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: vi.fn(() =>
        Promise.resolve({
          error: dbShouldFail ? { message: 'connection refused' } : null,
          count: dbShouldFail ? null : 0,
        })
      ),
    }),
  }),
}));

import { GET } from '../route';

interface HealthBody {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    db: boolean;
    polar: boolean;
    openrouter: boolean;
    resend: boolean;
    version: string;
    commit: string;
  };
  timestamp: string;
  elapsed_ms: number;
}

/**
 * Mock fetch by URL substring. Lets each test simulate one external dep
 * being down without affecting the others.
 */
function mockFetch(behavior: {
  polarOk?: boolean;
  openrouterOk?: boolean;
  resendOk?: boolean;
  /** When set, overrides the resend response status (e.g. 502 for 5xx outage). */
  resendStatus?: number;
  resendVerifiedDomains?: number;
  polarThrows?: boolean;
  openrouterThrows?: boolean;
  resendThrows?: boolean;
}) {
  global.fetch = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('polar.sh')) {
      if (behavior.polarThrows) return Promise.reject(new Error('polar net'));
      return Promise.resolve({
        ok: behavior.polarOk ?? true,
        status: behavior.polarOk ?? true ? 200 : 502,
      });
    }
    if (url.includes('openrouter.ai')) {
      if (behavior.openrouterThrows) return Promise.reject(new Error('or net'));
      return Promise.resolve({
        ok: behavior.openrouterOk ?? true,
        status: behavior.openrouterOk ?? true ? 200 : 503,
      });
    }
    if (url.includes('api.resend.com')) {
      if (behavior.resendThrows) return Promise.reject(new Error('resend net'));
      const ok = behavior.resendOk ?? true;
      const verifiedCount = behavior.resendVerifiedDomains ?? 1;
      const data = Array.from({ length: verifiedCount }, () => ({
        status: 'verified',
      }));
      const status = behavior.resendStatus ?? (ok ? 200 : 401);
      return Promise.resolve({
        ok,
        status,
        json: () => Promise.resolve({ data }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  }) as unknown as typeof global.fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbShouldFail = false;
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.RESEND_API_KEY = 're-test-key';
});

describe('GET /api/health', () => {
  it('happy path: every dep healthy => 200 status=ok', async () => {
    mockFetch({ polarOk: true, openrouterOk: true, resendOk: true });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe(true);
    expect(body.checks.polar).toBe(true);
    expect(body.checks.openrouter).toBe(true);
    expect(body.checks.resend).toBe(true);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('db down: 503 status=down', async () => {
    dbShouldFail = true;
    mockFetch({ polarOk: true, openrouterOk: true, resendOk: true });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('down');
    expect(body.checks.db).toBe(false);
  });

  it('polar down: 503 status=degraded', async () => {
    mockFetch({ polarOk: false, openrouterOk: true, resendOk: true });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.polar).toBe(false);
    expect(body.checks.db).toBe(true);
  });

  it('openrouter down: 503 status=degraded', async () => {
    mockFetch({ polarOk: true, openrouterOk: false, resendOk: true });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.openrouter).toBe(false);
  });

  it('openrouter unset (preview env): treated healthy, status=ok', async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockFetch({ polarOk: true, resendOk: true });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.checks.openrouter).toBe(true);
    expect(body.status).toBe('ok');
  });

  it('resend down (4xx): 200 status=ok (warn+continue, scope mismatch)', async () => {
    // 4xx on /domains is informational only - actual send capability uses
    // the Resend SDK with a sending-scope key. Health stays green.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch({ polarOk: true, openrouterOk: true, resendOk: false, resendStatus: 401 });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks.resend).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Resend /domains returned 401'));
    warnSpy.mockRestore();
  });

  it('resend down (5xx): 503 status=degraded (real outage)', async () => {
    mockFetch({ polarOk: true, openrouterOk: true, resendOk: false, resendStatus: 503 });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.resend).toBe(false);
  });

  it('resend has no verified domains: 503 status=degraded', async () => {
    mockFetch({ polarOk: true, openrouterOk: true, resendOk: true, resendVerifiedDomains: 0 });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.resend).toBe(false);
  });

  it('resend unset (preview env): treated healthy, status=ok', async () => {
    delete process.env.RESEND_API_KEY;
    mockFetch({ polarOk: true, openrouterOk: true });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.checks.resend).toBe(true);
    expect(body.status).toBe('ok');
  });
});
