/**
 * Bootstrap Flow
 *
 * Coordinates the collapsed `styrby onboard` experience that should complete
 * in under 60 seconds from `npm install -g styrby` to first message on phone.
 *
 * Timeline budget (wall-clock):
 *   - Agent detection:      < 1 s   (sync which calls, cached)
 *   - OTP send:             < 3 s   (Supabase edge round-trip)
 *   - Email delivery:       3-10 s  (out of our control; OTP not OAuth)
 *   - User pastes code:     5-15 s  (user latency)
 *   - OTP verify:           < 2 s   (Supabase edge round-trip)
 *   - Machine register:     < 2 s   (Supabase DB insert)
 *   - QR render + scan:     5-20 s  (user latency)
 *   - Relay handshake:      < 3 s   (Realtime channel)
 *   Total controllable:     < 11 s
 *   Total user-latency:     8-45 s
 *   Combined p50:           ~30 s
 *   Combined p95:           ~55 s
 *
 * WHY this module exists:
 * onboard.ts previously scattered the flow logic across 6 top-level functions
 * with no shared timer context. bootstrap.ts owns the span recorder and
 * decision logic (agent pick, OTP vs. OAuth) so onboard.ts becomes a thin
 * arg-parser + result formatter.
 *
 * @module onboarding/bootstrap
 */

import { Logger, type LogContext } from '@styrby/shared/logging';

// ============================================================================
// Types
// ============================================================================

/**
 * A single timed step in the onboarding flow.
 */
export interface OnboardingSpan {
  /** Stable identifier for this step (snake_case). */
  step_id: string;
  /** Human-readable label. */
  label: string;
  /** Wall-clock timestamp when the step started (ms since epoch). */
  started_at: number;
  /** Wall-clock timestamp when the step finished (ms since epoch). */
  finished_at?: number;
  /** Duration in milliseconds (set when the step completes). */
  step_duration_ms?: number;
  /** Whether the step succeeded. */
  success?: boolean;
  /** Error message if the step failed. */
  error?: string;
}

/**
 * Aggregated timeline produced by a bootstrap run.
 */
export interface OnboardingTimeline {
  /** Per-step spans, in order of execution. */
  spans: OnboardingSpan[];
  /** Total elapsed ms from start to end (excludes unstarted steps). */
  total_ms: number;
}

// ============================================================================
// SpanRecorder
// ============================================================================

/**
 * Records structured timing spans for each onboarding step.
 *
 * Each span has a `step_id` + `step_duration_ms` so the founder can query
 * average per-step latency in Supabase Analytics and identify bottlenecks
 * without needing APM tooling.
 *
 * WHY a class instead of a plain array:
 * `start` / `finish` pairing is error-prone as a caller responsibility. The
 * class enforces the pairing: `start(id)` opens a span, `finish(id)` closes
 * it. If `finish` is called for an unknown id it no-ops rather than throwing,
 * preventing logging from crashing the onboarding flow.
 */
export class SpanRecorder {
  private readonly spans: Map<string, OnboardingSpan> = new Map();
  private readonly ordered: string[] = [];
  private readonly logger: Logger;
  private readonly userId?: string;
  private readonly traceId: string;

  /**
   * @param logger - Structured logger instance (from @styrby/shared/logging)
   * @param userId - Optional user ID for correlation (available after auth)
   */
  constructor(logger: Logger, userId?: string) {
    this.logger = logger;
    this.userId = userId;
    this.traceId = logger.getTraceId();
  }

  /**
   * Open a new timing span.
   *
   * @param stepId - Stable snake_case identifier (e.g. 'auth_start')
   * @param label - Human-readable label for display
   * @returns `this` for chaining
   */
  start(stepId: string, label: string): this {
    const span: OnboardingSpan = {
      step_id: stepId,
      label,
      started_at: Date.now(),
    };
    this.spans.set(stepId, span);
    this.ordered.push(stepId);

    const ctx: LogContext = {
      step_id: stepId,
      traceId: this.traceId,
      ...(this.userId ? { userId: this.userId } : {}),
    };
    this.logger.info(`onboard.step.start: ${label}`, ctx);
    return this;
  }

  /**
   * Close a timing span and record duration.
   *
   * @param stepId - The span id passed to `start()`
   * @param success - Whether the step succeeded (default true)
   * @param error - Error message if `success` is false
   * @returns Duration in ms, or 0 if span was not found
   */
  finish(stepId: string, success = true, error?: string): number {
    const span = this.spans.get(stepId);
    if (!span) return 0;

    span.finished_at = Date.now();
    span.step_duration_ms = span.finished_at - span.started_at;
    span.success = success;
    if (error) span.error = error;

    const ctx: LogContext = {
      step_id: stepId,
      step_duration_ms: span.step_duration_ms,
      success,
      traceId: this.traceId,
      ...(this.userId ? { userId: this.userId } : {}),
      ...(error ? { error } : {}),
    };
    this.logger.info(`onboard.step.finish: ${span.label}`, ctx);
    return span.step_duration_ms;
  }

  /**
   * Build the completed timeline.
   *
   * Only includes spans that have been started. Spans that were started but
   * not finished are included with `step_duration_ms = undefined` (the
   * onboarding flow was interrupted mid-step).
   *
   * @returns Aggregated timeline
   */
  getTimeline(): OnboardingTimeline {
    const spans = this.ordered.map((id) => this.spans.get(id)!);

    const completed = spans.filter((s) => s.step_duration_ms !== undefined);
    const total_ms = completed.reduce((sum, s) => sum + (s.step_duration_ms ?? 0), 0);

    return { spans, total_ms };
  }

  /**
   * Print a formatted per-step timeline to stdout.
   *
   * Used by `styrby onboard --measure`. Outputs a human-readable table plus
   * the total wall-clock time so the developer can identify slow steps at a
   * glance without parsing JSON.
   *
   * @param timeline - Timeline to render
   */
  static printTimeline(timeline: OnboardingTimeline): void {
    console.log('\n  ---- Onboarding Timeline ----');
    for (const span of timeline.spans) {
      const durationStr =
        span.step_duration_ms !== undefined
          ? `${span.step_duration_ms} ms`
          : '(incomplete)';
      const status = span.success === false ? ' FAILED' : '';
      console.log(`  ${span.step_id.padEnd(26)} ${durationStr.padStart(10)}${status}`);
      if (span.error) {
        console.log(`    error: ${span.error}`);
      }
    }
    const totalStr = `${timeline.total_ms} ms`;
    console.log(`  ${'TOTAL'.padEnd(26)} ${totalStr.padStart(10)}`);
    console.log('  ----------------------------\n');
  }
}

// ============================================================================
// Re-export types consumed by onboard.ts
// ============================================================================
export type { Logger };
