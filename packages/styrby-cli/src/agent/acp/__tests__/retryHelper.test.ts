import { describe, expect, it, vi } from 'vitest';
import { withRetry, withTimeout, RETRY_CONFIG } from '../retryHelper';

/**
 * withRetry / withTimeout are the resilience primitives used to bound and
 * recover ACP initialize + newSession RPCs. Wrong behavior here = either
 * stuck sessions or aggressive retry storms against a degraded agent.
 */
describe('RETRY_CONFIG', () => {
  it('exposes sane defaults', () => {
    expect(RETRY_CONFIG.maxAttempts).toBeGreaterThanOrEqual(2);
    expect(RETRY_CONFIG.baseDelayMs).toBeGreaterThan(0);
    expect(RETRY_CONFIG.maxDelayMs).toBeGreaterThanOrEqual(RETRY_CONFIG.baseDelayMs);
  });
});

describe('withRetry', () => {
  it('returns the value on first success without retrying', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op, {
      operationName: 'test',
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and resolves on a later attempt', async () => {
    const op = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('third');

    const result = await withRetry(op, {
      operationName: 'test',
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    expect(result).toBe('third');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws the last error when all attempts fail', async () => {
    const op = vi.fn().mockRejectedValue(new Error('persistent'));
    await expect(
      withRetry(op, {
        operationName: 'test',
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
      })
    ).rejects.toThrow('persistent');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('wraps non-Error throws into Error so the catch path is consistent', async () => {
    const op = vi.fn().mockRejectedValue('plain string');
    await expect(
      withRetry(op, {
        operationName: 'test',
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
      })
    ).rejects.toThrow('plain string');
  });

  it('invokes onRetry between attempts but not after the final failure', async () => {
    const onRetry = vi.fn();
    const op = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(
      withRetry(op, {
        operationName: 'test',
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        onRetry,
      })
    ).rejects.toThrow();
    // onRetry fires after attempts 1 and 2, NOT after attempt 3 (final).
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });
});

describe('withTimeout', () => {
  it('resolves with the operation value when it completes in time', async () => {
    const result = await withTimeout(
      () => Promise.resolve('done'),
      100,
      'should not fire'
    );
    expect(result).toBe('done');
  });

  it('rejects with the timeout message when the operation hangs', async () => {
    await expect(
      withTimeout(() => new Promise(() => undefined), 10, 'too slow')
    ).rejects.toThrow('too slow');
  });

  it('propagates the underlying rejection unchanged when it loses the race', async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error('inner')), 100, 'timeout-msg')
    ).rejects.toThrow('inner');
  });
});
