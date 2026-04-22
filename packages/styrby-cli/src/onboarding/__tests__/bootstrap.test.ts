/**
 * Tests for the bootstrap SpanRecorder (onboarding/bootstrap.ts).
 *
 * Covers:
 * - SpanRecorder.start: opens a span and emits a structured log event
 * - SpanRecorder.finish: closes the span, records duration, marks success/failure
 * - SpanRecorder.getTimeline: aggregates spans + computes total_ms
 * - SpanRecorder.printTimeline: prints the formatted table to stdout
 * - Timeline event ordering: spans appear in start order
 * - Fast-clock simulation: asserts step_duration_ms is numeric and non-negative
 *
 * WHY: SpanRecorder is the measurement contract for Phase 1.6.5. If spans
 * fire out of order, or total_ms is wrong, the founder's dashboard shows
 * misleading onboarding latency data.
 *
 * @module onboarding/__tests__/bootstrap.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@styrby/shared/logging';
import { SpanRecorder } from '../bootstrap.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a Logger that captures written lines for assertion.
 */
function makeTestLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = new Logger({
    minLevel: 'debug',
    writeFn: (line) => lines.push(line),
  });
  return { logger, lines };
}

// ============================================================================
// SpanRecorder.start / finish
// ============================================================================

describe('SpanRecorder — start / finish', () => {
  it('logs a start event with step_id', () => {
    const { logger, lines } = makeTestLogger();
    const rec = new SpanRecorder(logger);

    rec.start('auth_start', 'Auth: send OTP');

    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.message).toContain('onboard.step.start');
    expect(entry.context.step_id).toBe('auth_start');
  });

  it('logs a finish event with step_duration_ms', () => {
    const { logger, lines } = makeTestLogger();
    const rec = new SpanRecorder(logger);

    rec.start('auth_start', 'Auth: send OTP');
    rec.finish('auth_start');

    // Two log lines: start + finish
    expect(lines.length).toBe(2);
    const finishEntry = JSON.parse(lines[1]);
    expect(finishEntry.message).toContain('onboard.step.finish');
    expect(typeof finishEntry.context.step_duration_ms).toBe('number');
    expect(finishEntry.context.step_duration_ms).toBeGreaterThanOrEqual(0);
    expect(finishEntry.context.success).toBe(true);
  });

  it('records failure when success=false', () => {
    const { logger, lines } = makeTestLogger();
    const rec = new SpanRecorder(logger);

    rec.start('preflight', 'Pre-flight');
    rec.finish('preflight', false, 'No internet connection');

    const finishEntry = JSON.parse(lines[1]);
    expect(finishEntry.context.success).toBe(false);
    expect(finishEntry.context.error).toBe('No internet connection');
  });

  it('returns 0 when finishing an unknown step_id (no-op)', () => {
    const { logger } = makeTestLogger();
    const rec = new SpanRecorder(logger);
    expect(rec.finish('nonexistent', true)).toBe(0);
  });

  it('returns the duration from finish()', () => {
    const { logger } = makeTestLogger();
    const rec = new SpanRecorder(logger);
    rec.start('machine_register', 'Machine registration');
    const duration = rec.finish('machine_register');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(typeof duration).toBe('number');
  });
});

// ============================================================================
// SpanRecorder.getTimeline
// ============================================================================

describe('SpanRecorder.getTimeline', () => {
  it('returns spans in start order', () => {
    const { logger } = makeTestLogger();
    const rec = new SpanRecorder(logger);

    rec.start('preflight', 'Pre-flight');
    rec.finish('preflight');
    rec.start('auth_start', 'Auth: send OTP');
    rec.finish('auth_start');
    rec.start('machine_register', 'Machine registration');
    rec.finish('machine_register');

    const { spans } = rec.getTimeline();
    expect(spans.map((s) => s.step_id)).toEqual([
      'preflight',
      'auth_start',
      'machine_register',
    ]);
  });

  it('total_ms is the sum of all completed step durations', () => {
    // Use a fake Date.now to control timing
    let fakeNow = 1000;
    const origNow = Date.now;
    Date.now = () => fakeNow;

    try {
      const { logger } = makeTestLogger();
      const rec = new SpanRecorder(logger);

      rec.start('step_a', 'Step A');
      fakeNow = 1050; // +50ms
      rec.finish('step_a');

      rec.start('step_b', 'Step B');
      fakeNow = 1200; // +150ms
      rec.finish('step_b');

      const timeline = rec.getTimeline();
      expect(timeline.total_ms).toBe(200); // 50 + 150
    } finally {
      Date.now = origNow;
    }
  });

  it('includes an unfinished span with undefined step_duration_ms', () => {
    const { logger } = makeTestLogger();
    const rec = new SpanRecorder(logger);
    rec.start('pair_complete', 'Pair: wait for mobile');
    // Not finished

    const { spans } = rec.getTimeline();
    expect(spans.length).toBe(1);
    expect(spans[0].step_duration_ms).toBeUndefined();
  });

  it('unfinished spans are excluded from total_ms', () => {
    const { logger } = makeTestLogger();
    const rec = new SpanRecorder(logger);

    rec.start('step_a', 'Step A');
    rec.finish('step_a'); // duration will be ~0ms in test

    rec.start('step_b', 'Step B');
    // Not finished

    const { total_ms, spans } = rec.getTimeline();
    // total_ms should only include step_a
    const stepA = spans.find((s) => s.step_id === 'step_a')!;
    expect(total_ms).toBe(stepA.step_duration_ms);
  });
});

// ============================================================================
// SpanRecorder.printTimeline
// ============================================================================

describe('SpanRecorder.printTimeline', () => {
  it('prints step_id and duration for each completed span', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      SpanRecorder.printTimeline({
        spans: [
          {
            step_id: 'auth_start',
            label: 'Auth: send OTP',
            started_at: 1000,
            finished_at: 1120,
            step_duration_ms: 120,
            success: true,
          },
          {
            step_id: 'machine_register',
            label: 'Machine registration',
            started_at: 1120,
            finished_at: 1380,
            step_duration_ms: 260,
            success: true,
          },
        ],
        total_ms: 380,
      });

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('auth_start');
      expect(output).toContain('120 ms');
      expect(output).toContain('machine_register');
      expect(output).toContain('260 ms');
      expect(output).toContain('380 ms');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('marks failed spans with FAILED', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      SpanRecorder.printTimeline({
        spans: [
          {
            step_id: 'preflight',
            label: 'Pre-flight',
            started_at: 0,
            finished_at: 100,
            step_duration_ms: 100,
            success: false,
            error: 'No internet',
          },
        ],
        total_ms: 100,
      });

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('FAILED');
      expect(output).toContain('No internet');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ============================================================================
// Full bootstrap simulation — fast clock
// ============================================================================

describe('Bootstrap simulation', () => {
  it('fires all 6 onboarding spans in order and assembles a valid timeline', () => {
    let fakeNow = 0;
    const origNow = Date.now;
    Date.now = () => fakeNow;

    try {
      const { logger } = makeTestLogger();
      const rec = new SpanRecorder(logger, 'user-sim-123');

      const steps: [string, string, number][] = [
        ['preflight',         'Pre-flight checks',       50],
        ['auth_start',        'Auth: send OTP',          80],
        ['auth_complete',     'Auth: complete',          20],
        ['machine_register',  'Machine registration',   150],
        ['agent_detect',      'Agent detection',          8],
        ['pair_start',        'Pair: QR generation',     12],
        ['pair_complete',     'Pair: wait for mobile', 4000],
      ];

      for (const [id, label, duration] of steps) {
        rec.start(id, label);
        fakeNow += duration;
        rec.finish(id);
      }

      const timeline = rec.getTimeline();

      // All 7 steps recorded
      expect(timeline.spans.length).toBe(7);

      // Steps are in order
      expect(timeline.spans.map((s) => s.step_id)).toEqual(steps.map(([id]) => id));

      // Each span has the mocked duration
      for (let i = 0; i < steps.length; i++) {
        expect(timeline.spans[i].step_duration_ms).toBe(steps[i][2]);
      }

      // Total = sum of all durations
      const expectedTotal = steps.reduce((sum, [, , d]) => sum + d, 0);
      expect(timeline.total_ms).toBe(expectedTotal);

      // All succeeded
      expect(timeline.spans.every((s) => s.success === true)).toBe(true);
    } finally {
      Date.now = origNow;
    }
  });
});
