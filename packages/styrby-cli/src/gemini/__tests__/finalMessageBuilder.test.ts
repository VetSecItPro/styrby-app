/**
 * Tests for `buildFinalTurnMessage`.
 *
 * The mobile app contract for the per-turn payload format lives here —
 * `type: 'message'`, `id`, `message`, optional `options[]`. Test the
 * exact shape so the contract can't drift silently.
 */
import { describe, it, expect } from 'vitest';
import { buildFinalTurnMessage } from '@/gemini/utils/finalMessageBuilder';

describe('buildFinalTurnMessage', () => {
  const fixedId = () => 'fixed-id';

  it('returns null for empty / whitespace-only response', () => {
    expect(buildFinalTurnMessage('', fixedId)).toBeNull();
    expect(buildFinalTurnMessage('   \n\t', fixedId)).toBeNull();
  });

  it('builds payload with no options for plain text', () => {
    const r = buildFinalTurnMessage('Hello, world!', fixedId);
    expect(r).not.toBeNull();
    expect(r!.payload).toEqual({
      type: 'message',
      message: 'Hello, world!',
      id: 'fixed-id',
    });
    expect(r!.options).toEqual([]);
    expect(r!.historyText).toBe('Hello, world!');
    expect(r!.incompleteOptions).toBe(false);
  });

  it('parses options + reattaches XML on payload', () => {
    const text = 'Pick one:\n<options><option>A</option><option>B</option></options>';
    const r = buildFinalTurnMessage(text, fixedId);
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['A', 'B']);
    expect(r!.payload.options).toEqual(['A', 'B']);
    // History text strips the options block
    expect(r!.historyText).not.toContain('<options>');
    // Payload message has options re-serialized
    expect(r!.payload.message).toContain('<options>');
    expect(r!.payload.message).toContain('A');
    expect(r!.payload.message).toContain('B');
  });

  it('omits `options` field on payload when none parsed', () => {
    const r = buildFinalTurnMessage('plain', fixedId);
    expect('options' in r!.payload).toBe(false);
  });

  it('flags incomplete options block (opener with no closer)', () => {
    const r = buildFinalTurnMessage('text <options><option>A</option>', fixedId);
    expect(r).not.toBeNull();
    expect(r!.options).toEqual([]);
    expect(r!.incompleteOptions).toBe(true);
  });

  it('uses default randomUUID when no id generator provided', () => {
    const r = buildFinalTurnMessage('hi');
    expect(r!.payload.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('id generator is invoked exactly once per build', () => {
    let calls = 0;
    const gen = () => `gen-${++calls}`;
    const r = buildFinalTurnMessage('hi', gen);
    expect(r!.payload.id).toBe('gen-1');
    expect(calls).toBe(1);
  });
});
