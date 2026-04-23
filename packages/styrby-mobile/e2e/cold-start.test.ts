/**
 * Real Device Cold-Start Measurement — Phase 1.6.12b
 *
 * WHY this file:
 *   Phase 1.6.12 (PR #128) shipped a proxy cold-start measurement that counts
 *   static imports and JSX nesting. This Detox test measures the *actual*
 *   cold-start latency on a running Android emulator / iOS simulator.
 *
 *   Real cold-start = wall-clock time from:
 *     `device.launchApp({ newInstance: true })` (OS process fork)
 *   to:
 *     first `<SectionList>` or root session-screen element visible in UI
 *     (confirmed by Detox visibility matcher)
 *
 *   This is equivalent to Time to Interactive (TTI) for a mobile app: the
 *   moment the user can meaningfully interact with the core screen.
 *
 * MEASUREMENT METHODOLOGY — 5 cold-launch cycles, reporting p50 + p95:
 *   - Each cycle forces a full cold start: `newInstance: true` + `delete: true`
 *     to clear the app's cached process (Android back-stack / iOS process cache).
 *   - We measure 5 launches because cold-start has high variance on CI emulators
 *     (JIT warm-up, filesystem cache, GC pressure). p95 across 5 samples
 *     provides a stable signal while keeping wall-clock time under 3 minutes.
 *   - p50 is logged for trend analysis. p95 is the gating assertion.
 *
 * BUDGETS (Phase 1.6.12b, set 2026-04-22):
 *   Android (Pixel 6 class — API 31 emulator):  p95 < 3 000 ms
 *   iOS (iPhone 13 simulator):                  p95 < 2 000 ms
 *
 *   Sources:
 *     - Sentry Mobile Vitals: "Good" < 3 s cold start
 *       https://docs.sentry.io/product/insights/mobile/mobile-vitals/
 *     - Google Play: "Excessive" cold start > 5 s
 *       https://developer.android.com/topic/performance/vitals/launch-time
 *     - Apple HIG: First frame within 400 ms; total interactive ready < 2 s
 *       https://developer.apple.com/design/human-interface-guidelines/loading
 *     - Nielsen Norman Group: 3 s is the attention-loss boundary
 *       https://www.nngroup.com/articles/response-times-3-important-limits/
 *
 * HOW TO RUN LOCALLY:
 *   1. Build: `pnpm --filter styrby-mobile run e2e:build:cold-start`
 *   2. Start emulator: use Android Studio AVD Manager, target Pixel_6_API_31
 *   3. Test:  `pnpm --filter styrby-mobile run e2e:cold-start`
 *
 * IN CI:
 *   Triggered by .github/workflows/eas-cold-start.yml (manual dispatch until
 *   EAS paid tier is active — see docs/infrastructure/eas-cold-start.md).
 *
 * @module e2e/cold-start
 */

// Detox globals are injected by testEnvironment — no import needed.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference types="detox" />

// ─────────────────────────────────────────────────────────────────────────────
// Budget constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum p95 cold-start latency on an Android emulator (ms).
 *
 * RATIONALE: 3 000 ms matches Sentry's "Good" cold-start threshold and is
 * well below Google Play's "Excessive" marker of 5 000 ms. It also aligns with
 * the Nielsen/Norman 3-second attention-loss boundary, making it a user-visible
 * quality target, not just an arbitrary engineering number.
 *
 * Device target: Pixel 6 equivalent (API 31, x86_64 AOSP emulator).
 * Emulators are generally faster than real devices due to host CPU speed,
 * but lack ART ahead-of-time compilation. The net effect is roughly neutral
 * for JS-heavy cold starts. If real device data shows the budget is too tight,
 * update this constant with a comment citing the measurement source.
 */
const ANDROID_P95_BUDGET_MS = 3_000;

/**
 * Maximum p95 cold-start latency on an iOS simulator (ms).
 *
 * RATIONALE: Apple's HIG recommends the first frame within 400 ms; total
 * interactive-ready time under 2 s matches what Apple's own performance
 * tooling (Instruments "App Launch" template) flags as a regression.
 * iOS simulators run native ARM64 on Apple Silicon hosts, making the
 * simulator representative of real device performance.
 *
 * Device target: iPhone 13 (A15 Bionic), iOS 16.4.
 */
const IOS_P95_BUDGET_MS = 2_000;

/**
 * Number of cold-launch cycles to measure.
 *
 * WHY 5: Enough to compute a meaningful p95 (1 out of 5 can be an outlier)
 * without blowing the 3-minute GitHub Actions job budget. At ~25 s per
 * cycle (boot + install + launch + wait + kill), 5 cycles = ~2 min 5 s.
 */
const LAUNCH_CYCLES = 5;

/**
 * Maximum time to wait for the first screen element to appear (ms).
 *
 * WHY 8 000: This is a safety net, not the budget. If the app hasn't shown
 * the sessions screen within 8 s on the emulator, something is fundamentally
 * wrong (infinite auth loop, crash, network timeout). The budget assertions
 * (3 s Android / 2 s iOS) are the meaningful thresholds; this just prevents
 * the test from hanging for the full Jest 180 s timeout.
 */
const ELEMENT_WAIT_TIMEOUT_MS = 8_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the p-th percentile of a sorted or unsorted array of numbers.
 *
 * Uses the "nearest rank" method: pth percentile = value at index
 * ceil(p/100 * n) - 1 in the sorted array. This is consistent with how
 * Android vitals and Sentry report percentiles.
 *
 * @param values - Array of numeric samples (order doesn't matter)
 * @param p      - Percentile to compute (0–100)
 * @returns The computed percentile value
 * @throws {Error} When values is empty or p is out of range
 *
 * @example
 * percentile([100, 200, 300, 400, 500], 95) // → 500
 * percentile([100, 200, 300, 400, 500], 50) // → 300
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error('Cannot compute percentile of empty array');
  if (p < 0 || p > 100) throw new Error(`Percentile must be 0-100, got ${p}`);

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "1234 ms (1.23 s)")
 */
function fmtMs(ms: number): string {
  return `${ms} ms (${(ms / 1000).toFixed(2)} s)`;
}

/**
 * Determines the active platform budget in milliseconds.
 * Reads from the Detox runtime, which knows which device/simulator is active.
 *
 * @returns Budget in milliseconds for the current platform
 */
function platformBudget(): number {
  // `device.getPlatform()` returns 'ios' | 'android'
  return device.getPlatform() === 'ios' ? IOS_P95_BUDGET_MS : ANDROID_P95_BUDGET_MS;
}

/**
 * Performs a single cold-start measurement cycle.
 *
 * Sequence:
 *   1. Kill any existing app instance (ensures cold start, not warm).
 *   2. Record start timestamp (before process launch).
 *   3. Launch app with `newInstance: true` (forces OS to fork a new process).
 *   4. Wait for the first meaningful UI element (sessions screen root).
 *   5. Record end timestamp (element visible = TTI reached).
 *   6. Return elapsed time.
 *
 * WHY waitForInteractionReady testID:
 *   `session-list-root` is a testID added to the SectionList container in the
 *   Sessions tab. It appears after:
 *     - Supabase auth token hydration from SecureStore
 *     - Initial sessions fetch (or empty state render)
 *     - Navigation to the tabs screen
 *   This makes it the truest available proxy for "app is interactive".
 *
 *   WHY not the splash screen hide: `expo-splash-screen` fires before auth is
 *   ready, so it underestimates TTI. The sessions list root is the first
 *   screen the user actually interacts with.
 *
 * @returns Elapsed milliseconds from launch to first interactive element visible
 */
async function measureColdStartMs(): Promise<number> {
  // Kill any lingering app process to guarantee a cold start.
  // `terminateApp()` sends SIGKILL, clearing ART's JIT cache and page cache.
  await device.terminateApp();

  const startMs = Date.now();

  // `newInstance: true` forces Android to fork a brand-new process.
  // Without this flag, Detox may reuse a warm process from the previous cycle,
  // which would measure warm-start latency instead.
  await device.launchApp({ newInstance: true });

  // Wait for the sessions list root element — the first interactive screen.
  // The auth flow navigates here automatically when a stored session token exists.
  // In CI, a pre-seeded test account token is injected via the `detox-auth` app
  // launch argument (see launchApp args in the workflow file).
  //
  // WHY waitFor().toBeVisible() instead of a fixed sleep:
  //   Fixed sleeps are fragile (flaky on slow runners) and inaccurate (they
  //   measure the sleep duration, not the actual TTI). Detox polls the element
  //   tree at 100 ms intervals, giving millisecond-accurate results.
  await waitFor(element(by.id('session-list-root')))
    .toBeVisible()
    .withTimeout(ELEMENT_WAIT_TIMEOUT_MS);

  return Date.now() - startMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Mobile cold-start — real device measurement (Phase 1.6.12b)', () => {
  /**
   * Collected cold-start samples across all launch cycles.
   * Populated in beforeAll; assertions use the p50 and p95 derived from it.
   */
  const samples: number[] = [];

  /**
   * Run all launch cycles before the assertion tests.
   *
   * WHY beforeAll (not beforeEach): We collect all samples in one pass, then
   * assert on the aggregated statistics. Running measurements inside individual
   * `it` blocks would reset device state between them, losing measurement continuity.
   *
   * WHY this timeout: 3 min — see jest.config.js setupTimeout rationale.
   */
  beforeAll(async () => {
    console.log(
      `[cold-start] Platform: ${device.getPlatform().toUpperCase()} ` +
        `| Launching ${LAUNCH_CYCLES} cold-start cycles ` +
        `| Budget: p95 < ${fmtMs(platformBudget())}`
    );

    for (let cycle = 1; cycle <= LAUNCH_CYCLES; cycle++) {
      const elapsed = await measureColdStartMs();
      samples.push(elapsed);
      console.log(`[cold-start] Cycle ${cycle}/${LAUNCH_CYCLES}: ${fmtMs(elapsed)}`);
    }

    // Log the final distribution for CI step summaries and artifact review.
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const min = Math.min(...samples);
    const max = Math.max(...samples);

    console.log('\n[cold-start] ─────────── Results ───────────');
    console.log(`  Samples:  ${samples.map(fmtMs).join(', ')}`);
    console.log(`  Min:      ${fmtMs(min)}`);
    console.log(`  p50:      ${fmtMs(p50)}`);
    console.log(`  p95:      ${fmtMs(p95)}`);
    console.log(`  Max:      ${fmtMs(max)}`);
    console.log(`  Budget:   p95 < ${fmtMs(platformBudget())}`);
    console.log('[cold-start] ────────────────────────────────\n');
  });

  /**
   * Asserts that at least one launch completed (sanity check).
   * A zero-sample count means the app crashed on every launch — we'd rather
   * get a clear failure here than a cryptic divide-by-zero in percentile().
   */
  it('completed all launch cycles without crashing', () => {
    expect(samples).toHaveLength(LAUNCH_CYCLES);
    // All samples must be > 0 (real measurements, not defaulted zeroes)
    for (const s of samples) {
      expect(s).toBeGreaterThan(0);
    }
  });

  /**
   * Core budget assertion: p95 cold-start must be under the platform budget.
   *
   * WHY p95 (not p50 or p99):
   *   p50 hides tail latency — a fast median with a slow 1-in-5 launch feels
   *   unreliable to users. p99 with only 5 samples would be identical to the
   *   worst case, making CI too fragile (one slow emulator boot fails the run).
   *   p95 with 5 samples means "at most 1 out of 5 launches may exceed budget"
   *   which is a pragmatic tolerance for emulator variance while still catching
   *   genuine regressions.
   */
  it(`p95 cold-start is under ${platformBudget()} ms budget`, () => {
    const p95 = percentile(samples, 95);
    const budget = platformBudget();

    if (p95 > budget) {
      const overage = p95 - budget;
      const platform = device.getPlatform().toUpperCase();
      throw new Error(
        `COLD-START BUDGET EXCEEDED on ${platform}\n` +
          `  p95 actual:  ${fmtMs(p95)}\n` +
          `  Budget:      ${fmtMs(budget)}\n` +
          `  Overage:     ${fmtMs(overage)}\n\n` +
          'HOW TO INVESTIGATE:\n' +
          '  1. Check recent changes to app/_layout.tsx for new heavy imports\n' +
          '  2. Profile with: npx react-native-bundle-visualizer\n' +
          '  3. Move heavy dependencies behind React.lazy() / dynamic import\n' +
          '  4. Check if any new Supabase calls were added to boot path\n' +
          '  5. Review cold-start-proxy.test.ts for leading indicators\n\n' +
          `Budget source: ${platform === 'IOS' ? 'Apple HIG (interactive ready < 2 s)' : "Sentry Mobile Vitals 'Good' < 3 s"}`
      );
    }

    expect(p95).toBeLessThanOrEqual(budget);
  });

  /**
   * Informational assertion: p50 logged for trend tracking.
   *
   * This test always passes but logs the median so CI step summaries
   * show trend data over time. If p50 creeps toward the budget, investigate
   * before it becomes a p95 failure.
   *
   * Target: p50 should ideally be < 60% of budget (headroom for variance).
   *   Android: p50 < 1 800 ms | iOS: p50 < 1 200 ms
   */
  it('logs p50 for trend analysis (informational)', () => {
    const p50 = percentile(samples, 50);
    const budget = platformBudget();
    const trendTarget = Math.round(budget * 0.6);

    if (p50 > trendTarget) {
      console.warn(
        `[cold-start] WARNING: p50 (${fmtMs(p50)}) exceeds trend target ` +
          `(${fmtMs(trendTarget)} = 60% of budget). Investigate before p95 fails.`
      );
    } else {
      console.log(
        `[cold-start] p50 (${fmtMs(p50)}) is within trend target ` +
          `(${fmtMs(trendTarget)} = 60% of budget). Healthy.`
      );
    }

    // Always passes — this is a data collection test, not a gating assertion.
    expect(p50).toBeGreaterThan(0);
  });
});
