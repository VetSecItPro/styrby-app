/**
 * Tests for launchRetryPolicy — bounded-retry decision logic.
 *
 * WHY (B4-Wave3): The previous claudeLocalLauncher loop had no retry cap.
 * If the Claude binary kept failing within milliseconds (PATH issue,
 * missing install, corrupted node_modules), the loop spun forever burning
 * CPU. The policy added here caps consecutive fast failures at 3 with a
 * clear give-up message. These tests pin that contract.
 *
 * @module claude/utils/__tests__/launchRetryPolicy
 */

import { describe, it, expect } from 'vitest';
import {
  createLaunchRetryState,
  decideRetry,
  FAST_FAIL_WINDOW_MS,
  MAX_CONSECUTIVE_FAST_FAILURES,
} from '../launchRetryPolicy';

describe('launchRetryPolicy', () => {
  // --------------------------------------------------------------------------
  // createLaunchRetryState
  // --------------------------------------------------------------------------

  it('createLaunchRetryState returns a fresh state with 0 consecutive failures', () => {
    const state = createLaunchRetryState();
    expect(state.consecutiveFastFailures).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Slow failures: never give up
  // --------------------------------------------------------------------------

  it('a SLOW failure (>= FAST_FAIL_WINDOW_MS) decides RETRY', () => {
    const state = createLaunchRetryState();
    const decision = decideRetry(state, FAST_FAIL_WINDOW_MS + 100);

    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.consecutiveFastFailures).toBe(0);
    }
  });

  it('many SLOW failures in a row never trigger give-up (counter stays at 0)', () => {
    const state = createLaunchRetryState();

    for (let i = 0; i < 50; i++) {
      const decision = decideRetry(state, FAST_FAIL_WINDOW_MS + 500);
      expect(decision.action).toBe('retry');
    }

    expect(state.consecutiveFastFailures).toBe(0);
  });

  it('a SLOW failure RESETS the fast-fail counter (different problem class)', () => {
    const state = createLaunchRetryState();

    // Two fast failures
    decideRetry(state, 100);
    decideRetry(state, 100);
    expect(state.consecutiveFastFailures).toBe(2);

    // One slow failure resets
    const slowDecision = decideRetry(state, FAST_FAIL_WINDOW_MS + 100);
    expect(slowDecision.action).toBe('retry');
    expect(state.consecutiveFastFailures).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Fast failures: give up after threshold
  // --------------------------------------------------------------------------

  it('a single FAST failure decides RETRY (under threshold)', () => {
    const state = createLaunchRetryState();
    const decision = decideRetry(state, 100);

    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.consecutiveFastFailures).toBe(1);
    }
  });

  it(`gives up after exactly MAX_CONSECUTIVE_FAST_FAILURES (${MAX_CONSECUTIVE_FAST_FAILURES}) consecutive fast failures`, () => {
    const state = createLaunchRetryState();

    // First (MAX - 1) fast failures: still retry
    for (let i = 0; i < MAX_CONSECUTIVE_FAST_FAILURES - 1; i++) {
      const d = decideRetry(state, 100);
      expect(d.action).toBe('retry');
    }

    // The Nth fast failure trips give-up
    const giveUp = decideRetry(state, 100);
    expect(giveUp.action).toBe('give-up');
    if (giveUp.action === 'give-up') {
      expect(giveUp.consecutiveFastFailures).toBe(MAX_CONSECUTIVE_FAST_FAILURES);
      // Reason mentions the threshold + the binary so users get an actionable hint
      expect(giveUp.reason).toContain('claude');
      expect(giveUp.reason).toContain(String(MAX_CONSECUTIVE_FAST_FAILURES));
      expect(giveUp.reason).toContain('PATH');
    }
  });

  // --------------------------------------------------------------------------
  // Edge: failure RIGHT AT the boundary
  // --------------------------------------------------------------------------

  it('a failure exactly at FAST_FAIL_WINDOW_MS counts as SLOW (>= boundary)', () => {
    const state = createLaunchRetryState();
    const decision = decideRetry(state, FAST_FAIL_WINDOW_MS);

    // Equal-to is the slow side per the helper's `<` comparison
    expect(decision.action).toBe('retry');
    expect(state.consecutiveFastFailures).toBe(0);
  });

  it('a failure at FAST_FAIL_WINDOW_MS - 1 counts as FAST', () => {
    const state = createLaunchRetryState();
    const decision = decideRetry(state, FAST_FAIL_WINDOW_MS - 1);

    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.consecutiveFastFailures).toBe(1);
    }
  });

  // --------------------------------------------------------------------------
  // Mixed sequences
  // --------------------------------------------------------------------------

  it('fast → fast → slow → fast: no give-up (slow reset broke the streak)', () => {
    const state = createLaunchRetryState();

    expect(decideRetry(state, 100).action).toBe('retry'); // fast: counter=1
    expect(decideRetry(state, 100).action).toBe('retry'); // fast: counter=2
    expect(decideRetry(state, FAST_FAIL_WINDOW_MS + 1).action).toBe('retry'); // slow: counter=0
    expect(decideRetry(state, 100).action).toBe('retry'); // fast: counter=1, no give-up

    expect(state.consecutiveFastFailures).toBe(1);
  });

  it('fast x N times after a slow reset: gives up only after another N consecutive fast', () => {
    const state = createLaunchRetryState();

    // Two fast, then a slow reset
    decideRetry(state, 100);
    decideRetry(state, 100);
    decideRetry(state, FAST_FAIL_WINDOW_MS + 100);

    // Now do MAX-1 more fast failures
    for (let i = 0; i < MAX_CONSECUTIVE_FAST_FAILURES - 1; i++) {
      const d = decideRetry(state, 100);
      expect(d.action).toBe('retry');
    }

    // The next one hits give-up
    expect(decideRetry(state, 100).action).toBe('give-up');
  });

  // --------------------------------------------------------------------------
  // Constants exported for callers + the contract that they're sane
  // --------------------------------------------------------------------------

  it('FAST_FAIL_WINDOW_MS is at least 1 second (avoid catching real session crashes)', () => {
    expect(FAST_FAIL_WINDOW_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('MAX_CONSECUTIVE_FAST_FAILURES is at least 2 (so a single-blip transient gets a retry)', () => {
    expect(MAX_CONSECUTIVE_FAST_FAILURES).toBeGreaterThanOrEqual(2);
  });
});
