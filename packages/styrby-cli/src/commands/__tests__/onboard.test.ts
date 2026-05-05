/**
 * Tests for ESC-1 onboard hardening: --browser flag, OTP-stuck fallback
 * prompt, and default-Y-on-Enter behaviour for the prompt timeout.
 *
 * WHY (ESC-1): Email-OTP-only auth dominates time-to-first-success when
 * delivery is slow. We added a `--browser` flag for opt-in browser-OAuth
 * and a 5s/10s fallback prompt that auto-suggests browser auth if the
 * user hasn't pasted their code yet. These tests cover the parser surface
 * and the interactive-prompt primitive.
 *
 * @module commands/__tests__/onboard.test
 */

import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// Mocks (kept lightweight — we test the pure helpers here, not the full flow)
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseOnboardArgs, promptYesNoWithTimeout } from '../onboard';

// ============================================================================
// parseOnboardArgs — --browser flag (ESC-1)
// ============================================================================

describe('parseOnboardArgs --browser flag', () => {
  it('sets options.browser=true when --browser is present', () => {
    const opts = parseOnboardArgs(['--browser']);
    expect(opts.browser).toBe(true);
  });

  it('leaves browser undefined when --browser is absent (default email OTP)', () => {
    const opts = parseOnboardArgs(['--skip-doctor']);
    expect(opts.browser).toBeUndefined();
  });

  it('coexists with other flags', () => {
    const opts = parseOnboardArgs(['--browser', '--skip-pairing', '--measure']);
    expect(opts.browser).toBe(true);
    expect(opts.skipPairing).toBe(true);
    expect(opts.measure).toBe(true);
  });
});

// ============================================================================
// promptYesNoWithTimeout — fallback prompt primitive (ESC-1)
// ============================================================================

describe('promptYesNoWithTimeout', () => {
  it('defaults to TRUE when the user just hits Enter', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('')),
      close: vi.fn(),
    };
    const result = await promptYesNoWithTimeout('Try browser auth?', 1000, rl);
    expect(result).toBe(true);
  });

  it('returns FALSE when the user types "n"', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('n')),
      close: vi.fn(),
    };
    const result = await promptYesNoWithTimeout('Try browser auth?', 1000, rl);
    expect(result).toBe(false);
  });

  it('returns FALSE for "no" (case-insensitive)', async () => {
    const rl = {
      question: vi.fn((_q: string, cb: (a: string) => void) => cb('NO')),
      close: vi.fn(),
    };
    expect(await promptYesNoWithTimeout('?', 1000, rl)).toBe(false);
  });

  it('auto-resolves to TRUE when no answer arrives before the timeout', async () => {
    // Never invoke the callback → simulate the user not typing anything.
    const rl = {
      question: vi.fn((_q: string, _cb: (a: string) => void) => {
        /* intentionally never call cb */
      }),
      close: vi.fn(),
    };
    const result = await promptYesNoWithTimeout('Try browser auth?', 50, rl);
    expect(result).toBe(true);
  });
});
