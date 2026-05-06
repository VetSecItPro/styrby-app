/**
 * Tests for ui/ink/messageBuffer.ts.
 *
 * Coverage target: 0% → 100% on the MessageBuffer class + factory.
 *
 * The class is a simple ring-buffer with a max-message cap; tests pin the
 * trimming behavior, add/clear/get semantics, and the factory's pass-through
 * of the maxMessages arg.
 *
 * @module ui/ink/__tests__/messageBuffer
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MessageBuffer, createMessageBuffer } from '@/ui/ink/messageBuffer';

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // MessageBuffer.add() prints to console — silence it for clean test output.
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('MessageBuffer.add', () => {
  it('adds a message with auto-generated id + timestamp', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'hello' });
    const msgs = buf.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('hello');
    expect(msgs[0].type).toBe('user');
    expect(typeof msgs[0].id).toBe('string');
    expect(msgs[0].id).not.toBe(''); // crypto.randomUUID()
    expect(typeof msgs[0].timestamp).toBe('number');
  });

  it('preserves insertion order across multiple adds', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'first' });
    buf.add({ type: 'agent', content: 'second' });
    buf.add({ type: 'system', content: 'third' });
    const msgs = buf.getMessages();
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('assigns unique ids per message', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'a' });
    buf.add({ type: 'user', content: 'b' });
    const ids = buf.getMessages().map((m) => m.id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('prints each added message to console (with type prefix)', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'hi' });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/👤 hi/));
  });

  it('uses correct emoji prefix per message type', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'u' });
    buf.add({ type: 'agent', content: 'a' });
    buf.add({ type: 'system', content: 's' });
    buf.add({ type: 'error', content: 'e' });
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toMatch(/👤 u/);
    expect(calls[1]).toMatch(/🤖 a/);
    expect(calls[2]).toMatch(/ℹ️ s/);
    expect(calls[3]).toMatch(/❌ e/);
  });
});

describe('MessageBuffer trimming', () => {
  it('keeps only the last N messages when over maxMessages', () => {
    const buf = new MessageBuffer(3);
    buf.add({ type: 'user', content: '1' });
    buf.add({ type: 'user', content: '2' });
    buf.add({ type: 'user', content: '3' });
    buf.add({ type: 'user', content: '4' });
    const msgs = buf.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.content)).toEqual(['2', '3', '4']);
  });

  it('uses default cap of 100 when maxMessages not specified', () => {
    const buf = new MessageBuffer();
    for (let i = 0; i < 105; i++) {
      buf.add({ type: 'user', content: `m${i}` });
    }
    const msgs = buf.getMessages();
    expect(msgs).toHaveLength(100);
    expect(msgs[0].content).toBe('m5'); // first 5 trimmed
    expect(msgs[99].content).toBe('m104');
  });

  it('does not trim when count equals maxMessages exactly', () => {
    const buf = new MessageBuffer(2);
    buf.add({ type: 'user', content: 'a' });
    buf.add({ type: 'user', content: 'b' });
    expect(buf.getMessages()).toHaveLength(2);
  });
});

describe('MessageBuffer.clear', () => {
  it('removes all messages', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'x' });
    buf.add({ type: 'user', content: 'y' });
    expect(buf.getMessages()).toHaveLength(2);
    buf.clear();
    expect(buf.getMessages()).toHaveLength(0);
    expect(buf.length).toBe(0);
  });

  it('clearing then adding works (no stale state)', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'old' });
    buf.clear();
    buf.add({ type: 'user', content: 'new' });
    const msgs = buf.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });
});

describe('MessageBuffer.getMessages', () => {
  it('returns a copy (mutating returned array does not affect buffer)', () => {
    const buf = new MessageBuffer();
    buf.add({ type: 'user', content: 'x' });
    const snapshot = buf.getMessages();
    snapshot.push({ id: 'fake', type: 'user', content: 'injected', timestamp: 0 });
    expect(buf.getMessages()).toHaveLength(1); // buffer NOT mutated
    expect(buf.getMessages()[0].content).toBe('x');
  });
});

describe('MessageBuffer.length getter', () => {
  it('reflects the current message count', () => {
    const buf = new MessageBuffer();
    expect(buf.length).toBe(0);
    buf.add({ type: 'user', content: 'a' });
    expect(buf.length).toBe(1);
    buf.add({ type: 'user', content: 'b' });
    expect(buf.length).toBe(2);
    buf.clear();
    expect(buf.length).toBe(0);
  });
});

describe('createMessageBuffer factory', () => {
  it('returns a MessageBuffer instance', () => {
    const buf = createMessageBuffer();
    expect(buf).toBeInstanceOf(MessageBuffer);
  });

  it('passes through maxMessages argument', () => {
    const buf = createMessageBuffer(2);
    buf.add({ type: 'user', content: '1' });
    buf.add({ type: 'user', content: '2' });
    buf.add({ type: 'user', content: '3' });
    expect(buf.getMessages()).toHaveLength(2);
  });

  it('uses default cap when no argument', () => {
    const buf = createMessageBuffer();
    for (let i = 0; i < 105; i++) {
      buf.add({ type: 'user', content: `${i}` });
    }
    expect(buf.length).toBe(100);
  });
});
