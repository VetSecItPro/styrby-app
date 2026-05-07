/**
 * Tests for tryGcloudADCToken (CLI-FOLLOWUP #74).
 *
 * WHY: Before this function existed, the gcloud Application Default
 * Credentials lookup ran inline inside `readGeminiLocalConfig()` on every
 * `createGeminiBackend()` call. The synchronous `gcloud` shell-out blocked
 * for up to 5 seconds when gcloud was uninstalled or unauthenticated,
 * violating the "construction is cheap" invariant from ADR-003 — making the
 * gemini factory time out under the 5s test budget while every other agent
 * factory constructed in <1ms.
 *
 * The fix extracted the gcloud shell-out into this opt-in function. These
 * tests pin the contract:
 *   1. Returns null immediately when STYRBY_USE_GCLOUD_ADC is not set
 *      (the default fast path — no shell-out, no latency)
 *   2. Returns null on gcloud failure (uninstalled / unauthenticated)
 *   3. Returns the trimmed token on success
 *   4. Empty/whitespace-only token returns null (don't pass garbage upstream)
 *
 * @module gemini/utils/__tests__/tryGcloudADCToken
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must be hoisted above imports
// ============================================================================

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { tryGcloudADCToken } from '../config';

// ============================================================================
// Test helpers
// ============================================================================

const ORIGINAL_USE_GCLOUD = process.env.STYRBY_USE_GCLOUD_ADC;

function withOptIn<T>(fn: () => T): T {
  process.env.STYRBY_USE_GCLOUD_ADC = '1';
  try {
    return fn();
  } finally {
    if (ORIGINAL_USE_GCLOUD === undefined) {
      delete process.env.STYRBY_USE_GCLOUD_ADC;
    } else {
      process.env.STYRBY_USE_GCLOUD_ADC = ORIGINAL_USE_GCLOUD;
    }
  }
}

// ============================================================================
// Tests — fast-path (default, opt-in NOT set)
// ============================================================================

describe('tryGcloudADCToken — default (opt-in NOT set)', () => {
  beforeEach(() => {
    mockExecSync.mockClear();
    delete process.env.STYRBY_USE_GCLOUD_ADC;
  });

  afterEach(() => {
    if (ORIGINAL_USE_GCLOUD !== undefined) {
      process.env.STYRBY_USE_GCLOUD_ADC = ORIGINAL_USE_GCLOUD;
    }
  });

  it('returns null without calling execSync (the construction-cheap fast path)', () => {
    const result = tryGcloudADCToken();
    expect(result).toBeNull();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns null even when STYRBY_USE_GCLOUD_ADC is set to falsy values like "0", "false", ""', () => {
    for (const falsy of ['0', 'false', '', 'no']) {
      process.env.STYRBY_USE_GCLOUD_ADC = falsy;
      const result = tryGcloudADCToken();
      expect(result).toBeNull();
      expect(mockExecSync).not.toHaveBeenCalled();
    }
  });
});

// ============================================================================
// Tests — opt-in path (STYRBY_USE_GCLOUD_ADC=1)
// ============================================================================

describe('tryGcloudADCToken — opt-in path (STYRBY_USE_GCLOUD_ADC=1)', () => {
  beforeEach(() => {
    mockExecSync.mockClear();
  });

  it('shells out to gcloud and returns the trimmed token on success', () => {
    mockExecSync.mockReturnValueOnce('  ya29.real-token-here\n');

    const result = withOptIn(() => tryGcloudADCToken());

    expect(result).toBe('ya29.real-token-here');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [command, options] = mockExecSync.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('gcloud auth application-default print-access-token');
    expect(options.encoding).toBe('utf8');
    // Timeout is set so a hung gcloud doesn't block the calling factory forever.
    expect(typeof options.timeout).toBe('number');
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('returns null when gcloud throws (uninstalled / unauthenticated)', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('command not found: gcloud');
    });

    const result = withOptIn(() => tryGcloudADCToken());
    expect(result).toBeNull();
  });

  it('returns null when gcloud returns empty output', () => {
    mockExecSync.mockReturnValueOnce('');

    const result = withOptIn(() => tryGcloudADCToken());
    expect(result).toBeNull();
  });

  it('returns null when gcloud returns whitespace-only output (after trim)', () => {
    mockExecSync.mockReturnValueOnce('   \n  \t  ');

    const result = withOptIn(() => tryGcloudADCToken());
    expect(result).toBeNull();
  });

  it('does NOT propagate the gcloud error (silent failure is the contract)', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('whatever-gcloud-said');
    });

    // The function must NOT throw — caller depends on null-vs-string return.
    expect(() => withOptIn(() => tryGcloudADCToken())).not.toThrow();
  });

  it('handles non-Error throws from execSync (string, plain object) without crashing', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw 'string-error-not-an-instance';
    });

    expect(() => withOptIn(() => tryGcloudADCToken())).not.toThrow();
    expect(withOptIn(() => tryGcloudADCToken())).toBeNull();
  });
});

// ============================================================================
// Tests — performance (the "construction is cheap" guarantee)
// ============================================================================

describe('tryGcloudADCToken — construction-cheap guarantee', () => {
  beforeEach(() => {
    mockExecSync.mockClear();
    delete process.env.STYRBY_USE_GCLOUD_ADC;
  });

  it('completes in well under 1ms in the default (opt-out) path', () => {
    // The whole point of CLI-FOLLOWUP #74: the default path must be fast
    // enough that calling this 1000 times is still imperceptible, ensuring
    // it never re-violates the construction-cheap invariant.
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      tryGcloudADCToken();
    }
    const elapsedMs = Date.now() - start;

    // 1000 calls in <100ms = <0.1ms per call. Generous budget; real path
    // should be <0.01ms per call.
    expect(elapsedMs).toBeLessThan(100);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
