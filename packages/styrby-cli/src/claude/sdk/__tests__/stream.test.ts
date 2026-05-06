/**
 * Tests for claude/sdk/stream.ts.
 *
 * Coverage target: 0% → ~100% on the Stream<T> class.
 *
 * Stream<T> is the async-iterable plumbing that backs Claude SDK message
 * delivery. Bugs here would corrupt streaming output, drop messages, or
 * crash on consumer disconnect — none of which would surface as a clear
 * stack trace, just "model output stopped working." Pinning the lifecycle
 * pre-emptively.
 *
 * @module claude/sdk/__tests__/stream
 */

import { describe, it, expect } from 'vitest';
import { Stream } from '@/claude/sdk/stream';

describe('Stream<T>: enqueue + iteration', () => {
  it('iterates pre-enqueued values', async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.enqueue(2);
    s.enqueue(3);
    s.done();

    const collected: number[] = [];
    for await (const v of s) collected.push(v);
    expect(collected).toEqual([1, 2, 3]);
  });

  it('iterates values enqueued after consumer awaits next()', async () => {
    const s = new Stream<string>();
    const collected: string[] = [];

    const consumer = (async () => {
      for await (const v of s) collected.push(v);
    })();

    // Schedule producer asynchronously so consumer is awaiting next() first.
    await Promise.resolve();
    s.enqueue('a');
    await Promise.resolve();
    s.enqueue('b');
    await Promise.resolve();
    s.done();

    await consumer;
    expect(collected).toEqual(['a', 'b']);
  });

  it('returns done immediately when no values + done() called pre-iteration', async () => {
    const s = new Stream<number>();
    s.done();
    const collected: number[] = [];
    for await (const v of s) collected.push(v);
    expect(collected).toEqual([]);
  });
});

describe('Stream<T>: error propagation', () => {
  it('rejects waiting next() with the error', async () => {
    const s = new Stream<number>();
    const consumer = (async () => {
      for await (const _ of s) { /* should throw */ }
    })();

    await Promise.resolve();
    s.error(new Error('boom'));

    await expect(consumer).rejects.toThrow('boom');
  });

  it('rejects subsequent next() with the error if no consumer waiting', async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.error(new Error('post-queue error'));

    const collected: number[] = [];
    let caught: Error | null = null;
    try {
      for await (const v of s) collected.push(v);
    } catch (e) {
      caught = e as Error;
    }
    expect(collected).toEqual([1]);
    expect(caught?.message).toBe('post-queue error');
  });
});

describe('Stream<T>: lifecycle invariants', () => {
  it('throws if iterated twice', () => {
    const s = new Stream<number>();
    s[Symbol.asyncIterator]();
    expect(() => s[Symbol.asyncIterator]()).toThrow('Stream can only be iterated once');
  });

  it('return() invokes optional cleanup callback', async () => {
    let cleanupCount = 0;
    const s = new Stream<number>(() => { cleanupCount += 1; });
    const result = await s.return();
    expect(result).toEqual({ done: true, value: undefined });
    expect(cleanupCount).toBe(1);
  });

  it('return() works without a cleanup callback', async () => {
    const s = new Stream<number>();
    const result = await s.return();
    expect(result).toEqual({ done: true, value: undefined });
  });

  it('return() marks stream done so subsequent next() returns done', async () => {
    const s = new Stream<number>();
    await s.return();
    const r = await s.next();
    expect(r).toEqual({ done: true, value: undefined });
  });
});

describe('Stream<T>: edge cases', () => {
  it('done() unblocks a waiting consumer cleanly', async () => {
    const s = new Stream<number>();
    const promise = s.next();
    s.done();
    const result = await promise;
    expect(result).toEqual({ done: true, value: undefined });
  });

  it('queue is FIFO across mixed pre/post-await producers', async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.enqueue(2);
    const r1 = await s.next();
    expect(r1.value).toBe(1);
    s.enqueue(3);
    const r2 = await s.next();
    expect(r2.value).toBe(2);
    const r3 = await s.next();
    expect(r3.value).toBe(3);
  });
});
