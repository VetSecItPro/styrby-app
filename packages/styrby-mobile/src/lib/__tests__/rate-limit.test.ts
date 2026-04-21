/**
 * Rate Limiter Utility Tests
 *
 * Tests the sliding-window rate limiter used to prevent Supabase API flooding
 * from rapid mobile UI interactions. Covers:
 * - Allowing calls within the rate limit
 * - Blocking calls that exceed maxCalls within windowMs
 * - Returning correct retryAfterMs when rate limited
 * - Resetting the limiter via reset()
 * - remaining() count decrements and recovers after window expiry
 * - createRateLimitedFetch convenience wrapper
 * - Error propagation from the wrapped function
 * - Sliding window semantics (old timestamps expire and free up slots)
 */

import { createRateLimiter, createRateLimitedFetch } from '../rate-limit';

// ============================================================================
// Test Suite
// ============================================================================

describe('createRateLimiter()', () => {
  // Use fake timers so we can advance time without waiting
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Happy path — calls within the limit
  // --------------------------------------------------------------------------

  describe('within the rate limit', () => {
    it('allows calls up to maxCalls within the window', async () => {
      const fn = jest.fn(async () => 'result');
      const limiter = createRateLimiter(fn, { maxCalls: 3, windowMs: 1000 });

      const r1 = await limiter.call();
      const r2 = await limiter.call();
      const r3 = await limiter.call();

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('returns the wrapped function result in allowed calls', async () => {
      const fn = jest.fn(async (x: number) => x * 2);
      const limiter = createRateLimiter(fn, { maxCalls: 5, windowMs: 1000 });

      const result = await limiter.call(7);

      expect(result.allowed).toBe(true);
      expect(result.result).toBe(14);
      expect(result.retryAfterMs).toBe(0);
    });

    it('passes arguments through to the wrapped function', async () => {
      const fn = jest.fn(async (a: string, b: number) => `${a}-${b}`);
      const limiter = createRateLimiter(fn, { maxCalls: 5, windowMs: 1000 });

      const result = await limiter.call('hello', 42);

      expect(fn).toHaveBeenCalledWith('hello', 42);
      expect(result.result).toBe('hello-42');
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting — calls that exceed maxCalls
  // --------------------------------------------------------------------------

  describe('exceeding the rate limit', () => {
    it('blocks calls once maxCalls is reached within the window', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 2, windowMs: 5000 });

      await limiter.call();
      await limiter.call();
      const blocked = await limiter.call();

      expect(blocked.allowed).toBe(false);
      expect(blocked.result).toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns retryAfterMs > 0 when rate limited', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 1, windowMs: 5000 });

      await limiter.call();
      const blocked = await limiter.call();

      expect(blocked.allowed).toBe(false);
      // WHY > 0: The first call was recorded at ~now, so retryAfterMs should
      // be approximately windowMs (5000ms) since the window hasn't expired.
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(5000);
    });

    it('does not call the wrapped function when rate limited', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 1, windowMs: 1000 });

      await limiter.call();
      await limiter.call(); // blocked

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Sliding window — old timestamps expire
  // --------------------------------------------------------------------------

  describe('sliding window expiry', () => {
    it('allows new calls after the window expires', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 2, windowMs: 1000 });

      // Exhaust the limit
      await limiter.call();
      await limiter.call();

      // Blocked before window expires
      const blocked = await limiter.call();
      expect(blocked.allowed).toBe(false);

      // Advance time past the window
      jest.advanceTimersByTime(1001);

      // Now calls should be allowed again
      const allowed = await limiter.call();
      expect(allowed.allowed).toBe(true);
    });

    it('only clears expired timestamps (partial window expiry)', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 3, windowMs: 2000 });

      // First call at t=0
      await limiter.call();

      // Advance 1500ms — first call is still within the 2000ms window
      jest.advanceTimersByTime(1500);

      // Two more calls at t=1500 — now at limit
      await limiter.call();
      await limiter.call();

      // Advance another 600ms (t=2100) — first call at t=0 is now expired
      jest.advanceTimersByTime(600);

      // The first slot is freed, allowing one more call
      const result = await limiter.call();
      expect(result.allowed).toBe(true);
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  // --------------------------------------------------------------------------
  // reset()
  // --------------------------------------------------------------------------

  describe('reset()', () => {
    it('clears all timestamps so calls are immediately allowed', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 2, windowMs: 5000 });

      await limiter.call();
      await limiter.call();

      // Confirm blocked before reset
      const blocked = await limiter.call();
      expect(blocked.allowed).toBe(false);

      // Reset
      limiter.reset();

      // Should be allowed again
      const allowed = await limiter.call();
      expect(allowed.allowed).toBe(true);
    });

    it('restores remaining() to maxCalls after reset', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 5, windowMs: 1000 });

      await limiter.call();
      await limiter.call();
      expect(limiter.remaining()).toBe(3);

      limiter.reset();

      expect(limiter.remaining()).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // remaining()
  // --------------------------------------------------------------------------

  describe('remaining()', () => {
    it('returns maxCalls when no calls have been made', () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 10, windowMs: 5000 });

      expect(limiter.remaining()).toBe(10);
    });

    it('decrements as calls are made', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 5, windowMs: 5000 });

      await limiter.call();
      expect(limiter.remaining()).toBe(4);

      await limiter.call();
      expect(limiter.remaining()).toBe(3);
    });

    it('returns 0 when the limit is exhausted', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 2, windowMs: 5000 });

      await limiter.call();
      await limiter.call();

      expect(limiter.remaining()).toBe(0);
    });

    it('increases again as old timestamps expire', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 2, windowMs: 1000 });

      await limiter.call();
      await limiter.call();
      expect(limiter.remaining()).toBe(0);

      // Wait for the window to expire
      jest.advanceTimersByTime(1001);
      expect(limiter.remaining()).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Error propagation
  // --------------------------------------------------------------------------

  describe('error propagation', () => {
    it('propagates errors thrown by the wrapped function', async () => {
      const fn = jest.fn(async () => {
        throw new Error('Supabase timeout');
      });
      const limiter = createRateLimiter(fn, { maxCalls: 5, windowMs: 1000 });

      await expect(limiter.call()).rejects.toThrow('Supabase timeout');
    });

    it('still consumes a slot even if the wrapped function throws', async () => {
      // WHY: A failed call that reached the network still counts against
      // the rate limit. We don't want retries to bypass rate limiting.
      const fn = jest.fn(async () => {
        throw new Error('fail');
      });
      const limiter = createRateLimiter(fn, { maxCalls: 1, windowMs: 1000 });

      // First call: throws but slot is consumed
      await expect(limiter.call()).rejects.toThrow();

      // Second call: rate limited
      const blocked = await limiter.call();
      expect(blocked.allowed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles maxCalls = 1 correctly', async () => {
      const fn = jest.fn(async () => 'single');
      const limiter = createRateLimiter(fn, { maxCalls: 1, windowMs: 1000 });

      const first = await limiter.call();
      expect(first.allowed).toBe(true);

      const second = await limiter.call();
      expect(second.allowed).toBe(false);
    });

    it('handles a very large maxCalls without issue', async () => {
      const fn = jest.fn(async () => 'ok');
      const limiter = createRateLimiter(fn, { maxCalls: 10000, windowMs: 60000 });

      const result = await limiter.call();
      expect(result.allowed).toBe(true);
      expect(limiter.remaining()).toBe(9999);
    });
  });
});

// ============================================================================
// createRateLimitedFetch convenience wrapper
// ============================================================================

describe('createRateLimitedFetch()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a rate limiter with 10 calls per 5 seconds', async () => {
    let callCount = 0;
    const fn = jest.fn(async () => ++callCount);
    const limiter = createRateLimitedFetch(fn);

    // 10 calls should all be allowed
    for (let i = 0; i < 10; i++) {
      const result = await limiter.call();
      expect(result.allowed).toBe(true);
    }

    // 11th call should be blocked
    const blocked = await limiter.call();
    expect(blocked.allowed).toBe(false);

    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('resets after 5 seconds', async () => {
    const fn = jest.fn(async () => 'ok');
    const limiter = createRateLimitedFetch(fn);

    // Exhaust the limit
    for (let i = 0; i < 10; i++) {
      await limiter.call();
    }

    // Advance 5 seconds + 1ms
    jest.advanceTimersByTime(5001);

    const result = await limiter.call();
    expect(result.allowed).toBe(true);
  });

  it('wraps a zero-argument function and passes no args', async () => {
    const fn = jest.fn(async () => ({ data: 'sessions' }));
    const limiter = createRateLimitedFetch(fn);

    const result = await limiter.call();

    expect(fn).toHaveBeenCalledWith();
    expect(result.result).toEqual({ data: 'sessions' });
  });

  it('remaining() starts at 10', () => {
    const fn = jest.fn(async () => 'ok');
    const limiter = createRateLimitedFetch(fn);

    expect(limiter.remaining()).toBe(10);
  });
});
