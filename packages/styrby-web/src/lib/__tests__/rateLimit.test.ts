import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rateLimit, getClientIp, rateLimitResponse, RATE_LIMITS } from '../rateLimit';

/**
 * Creates a minimal Request-like object for testing.
 * WHY: We only need the headers interface for rate limit checks.
 */
function createMockRequest(ip: string = '192.168.1.1'): Request {
  return {
    headers: new Headers({
      'x-forwarded-for': ip,
    }),
  } as unknown as Request;
}

describe('getClientIp', () => {
  it('extracts IP from x-forwarded-for header', () => {
    const req = createMockRequest('10.0.0.1');
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('handles multiple IPs in x-forwarded-for (takes first)', () => {
    const req = {
      headers: new Headers({
        'x-forwarded-for': '203.0.113.50, 70.41.3.18, 150.172.238.178',
      }),
    } as unknown as Request;
    expect(getClientIp(req)).toBe('203.0.113.50');
  });

  it('falls back to x-real-ip', () => {
    const req = {
      headers: new Headers({
        'x-real-ip': '10.0.0.2',
      }),
    } as unknown as Request;
    expect(getClientIp(req)).toBe('10.0.0.2');
  });

  it('returns "unknown" when no IP headers present', () => {
    const req = {
      headers: new Headers({}),
    } as unknown as Request;
    expect(getClientIp(req)).toBe('unknown');
  });

  it('trims whitespace from x-forwarded-for', () => {
    const req = {
      headers: new Headers({
        'x-forwarded-for': '  10.0.0.3  , 10.0.0.4',
      }),
    } as unknown as Request;
    expect(getClientIp(req)).toBe('10.0.0.3');
  });
});

describe('rateLimit', () => {
  beforeEach(() => {
    // Reset time mocking between tests
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const config = { windowMs: 60000, maxRequests: 5 };
    const req = createMockRequest('10.1.0.1');

    const result = rateLimit(req, config, 'test-allow');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.retryAfter).toBeUndefined();
  });

  it('blocks requests over the limit', () => {
    const config = { windowMs: 60000, maxRequests: 3 };
    const uniqueIp = `10.2.0.${Date.now() % 255}`;
    const req = createMockRequest(uniqueIp);
    const prefix = `test-block-${Date.now()}`;

    // Make 3 allowed requests
    rateLimit(req, config, prefix);
    rateLimit(req, config, prefix);
    rateLimit(req, config, prefix);

    // 4th should be blocked
    const result = rateLimit(req, config, prefix);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('uses separate windows for different key prefixes', () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    const req = createMockRequest('10.3.0.1');
    const prefix1 = `test-sep1-${Date.now()}`;
    const prefix2 = `test-sep2-${Date.now()}`;

    rateLimit(req, config, prefix1);
    const result = rateLimit(req, config, prefix2);
    expect(result.allowed).toBe(true);
  });

  it('uses separate windows for different IPs', () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    const prefix = `test-ip-${Date.now()}`;

    rateLimit(createMockRequest('10.4.0.1'), config, prefix);
    const result = rateLimit(createMockRequest('10.4.0.2'), config, prefix);
    expect(result.allowed).toBe(true);
  });

  it('resets window after expiration', () => {
    vi.useFakeTimers();
    const config = { windowMs: 1000, maxRequests: 1 };
    const req = createMockRequest('10.5.0.1');
    const prefix = `test-reset-${Date.now()}`;

    rateLimit(req, config, prefix);

    // Advance past the window
    vi.advanceTimersByTime(1500);

    const result = rateLimit(req, config, prefix);
    expect(result.allowed).toBe(true);
  });

  it('returns correct remaining count', () => {
    const config = { windowMs: 60000, maxRequests: 5 };
    const req = createMockRequest('10.6.0.1');
    const prefix = `test-remaining-${Date.now()}`;

    expect(rateLimit(req, config, prefix).remaining).toBe(4);
    expect(rateLimit(req, config, prefix).remaining).toBe(3);
    expect(rateLimit(req, config, prefix).remaining).toBe(2);
    expect(rateLimit(req, config, prefix).remaining).toBe(1);
    expect(rateLimit(req, config, prefix).remaining).toBe(0);
    // Over limit — remaining stays at 0
    expect(rateLimit(req, config, prefix).remaining).toBe(0);
  });
});

describe('rateLimitResponse', () => {
  it('returns 429 status with correct headers', async () => {
    const response = rateLimitResponse(30);
    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Retry-After')).toBe('30');
  });

  it('includes error details in body', async () => {
    const response = rateLimitResponse(60);
    const body = await response.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.retryAfter).toBe(60);
    expect(body.message).toBeDefined();
  });
});

describe('RATE_LIMITS', () => {
  it('has all expected presets', () => {
    expect(RATE_LIMITS.standard).toBeDefined();
    expect(RATE_LIMITS.sensitive).toBeDefined();
    expect(RATE_LIMITS.export).toBeDefined();
    expect(RATE_LIMITS.delete).toBeDefined();
    expect(RATE_LIMITS.checkout).toBeDefined();
    expect(RATE_LIMITS.budgetAlerts).toBeDefined();
    expect(RATE_LIMITS.apiV1).toBeDefined();
  });

  it('sensitive is stricter than standard', () => {
    expect(RATE_LIMITS.sensitive.maxRequests).toBeLessThan(RATE_LIMITS.standard.maxRequests);
  });

  it('export has the longest window', () => {
    const maxWindow = Math.max(
      ...Object.values(RATE_LIMITS).map(r => r.windowMs)
    );
    expect(RATE_LIMITS.delete.windowMs).toBe(maxWindow);
  });
});
