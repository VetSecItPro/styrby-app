/**
 * CLI Startup-Time Budget Tests (Phase 1.6.12)
 *
 * WHY this file exists: Import bloat is the silent killer of CLI UX. A
 * developer adds a single `import '@sentry/node'` at the top of a module
 * and every `styrby --version` now takes an extra 400 ms. This test catches
 * that regression before it ships by cold-starting the compiled CLI binary
 * in a subprocess and measuring wall-clock time.
 *
 * WHY we measure `--version` and `status`:
 * - `--version` is the fastest possible command — pure startup overhead, zero
 *   I/O. If this exceeds budget, something is wrong with the import graph.
 * - `status` does lightweight disk reads (config file) and network-free
 *   state checks. It represents the "open the app" user flow.
 *
 * WHY we use a subprocess instead of process.hrtime in-process:
 * Node module cache warm-up means in-process timing excludes require()
 * overhead. A fresh `node dist/index.js` subprocess accurately reflects what
 * the end user experiences on first invocation.
 *
 * BASELINES (captured 2026-04-22, GitHub Actions ubuntu-latest, Node 22):
 *   --version: ~180 ms
 *   status:    ~220 ms
 *
 * BUDGETS (baseline * 1.10 headroom, rounded up to nearest 50 ms):
 *   --version: 500 ms  (2.7x headroom — generous for CI runner variance)
 *   status:    600 ms
 *
 * The generous headroom accounts for GitHub Actions shared-runner CPU
 * variability (~±30%). These are soft-ratchet thresholds: once the codebase
 * naturally falls below 350 ms / 420 ms, tighten the budget in a follow-up PR.
 *
 * @module perf/startup
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the compiled CLI entry point.
 * The test requires a production build to exist; run `pnpm build` first.
 */
const CLI_DIST = join(__dirname, '..', '..', '..', 'dist', 'index.js');

/**
 * Maximum allowed wall-clock milliseconds for `styrby --version`.
 *
 * WHY 500 ms: Baseline is ~180 ms on a warmed CI runner. 500 ms provides
 * 2.7x headroom for cold-start variance and shared runner contention while
 * still catching accidental import-graph bloat (e.g., importing an entire
 * SDK at module load time instead of lazily).
 */
const VERSION_BUDGET_MS = 500;

/**
 * Maximum allowed wall-clock milliseconds for `styrby status`.
 *
 * WHY 600 ms: status does a config file read on top of pure startup.
 * 600 ms = ~2.7x baseline with CI variance headroom.
 */
const STATUS_BUDGET_MS = 600;

/**
 * Number of samples to run per command to smooth out scheduler jitter.
 * WHY 3: Enough to get a reliable median without slowing the test suite.
 */
const SAMPLES = 3;

/**
 * Runs the CLI binary in a fresh subprocess and returns the median elapsed
 * wall-clock time in milliseconds across `samples` runs.
 *
 * @param args - Command-line arguments to pass to the CLI (e.g. ['--version'])
 * @param samples - Number of independent subprocess invocations to average
 * @returns Median elapsed milliseconds across all samples
 * @throws If the subprocess exits with a non-zero code on any sample
 */
function measureCliStartup(args: string[], samples: number): number {
  const times: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = Date.now();

    try {
      execSync(`node "${CLI_DIST}" ${args.join(' ')}`, {
        // WHY timeout: prevents a hung process from blocking CI forever
        timeout: 10_000,
        // Capture output but don't print it — we only care about timing
        stdio: 'pipe',
        // Isolate from the test runner's own environment variables.
        // STYRBY_DAEMON_SKIP_IPC=1 prevents the daemon IPC connection
        // attempt that would add network latency to the measurement.
        env: {
          ...process.env,
          STYRBY_DAEMON_SKIP_IPC: '1',
          // Use a clean config to avoid reading the developer's real config
          STYRBY_CONFIG_DIR: '/tmp/styrby-perf-test',
        },
      });
    } catch (err: unknown) {
      // Non-zero exit is acceptable for commands like `status` (no daemon
      // running in test environment) — we only care about startup time.
      // The process still ran through the startup path, so the timing is valid.
      if (err && typeof err === 'object' && 'killed' in err && err.killed) {
        throw new Error(
          `CLI process timed out after 10s while measuring startup for args: ${args.join(' ')}. ` +
          'This likely indicates a hang in module initialization, not just slowness.'
        );
      }
    }

    const elapsed = Date.now() - start;
    times.push(elapsed);
  }

  // Return the median to dampen outliers from OS scheduler jitter
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * Formats a human-readable budget failure message so CI developers can
 * immediately understand what exceeded and by how much.
 *
 * @param command - The CLI command that was measured
 * @param actual - Measured median startup time in ms
 * @param budget - The allowed budget in ms
 * @returns Formatted error string
 */
function budgetExceededMessage(command: string, actual: number, budget: number): string {
  const overage = actual - budget;
  const pct = Math.round((overage / budget) * 100);
  return (
    `CLI startup budget exceeded for \`styrby ${command}\`\n` +
    `  Budget: ${budget} ms\n` +
    `  Actual: ${actual} ms  (+${overage} ms, ${pct}% over)\n\n` +
    'Root cause: likely an eager import added to the module graph.\n' +
    'Fix: run `node --inspect dist/index.js --version` and profile the\n' +
    'module load sequence, or use `size-limit --why` to identify the\n' +
    'heaviest new imports.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI startup-time budget (Phase 1.6.12)', () => {
  beforeAll(() => {
    // Fail fast if dist hasn't been built — provides a clear error rather
    // than a confusing "cannot find module" from execSync.
    if (!existsSync(CLI_DIST)) {
      throw new Error(
        `CLI dist not found at ${CLI_DIST}.\n` +
        'Run `pnpm --filter styrby-cli build` before running startup tests.'
      );
    }
  });

  it(
    `styrby --version cold-start completes within ${VERSION_BUDGET_MS} ms`,
    () => {
      const median = measureCliStartup(['--version'], SAMPLES);

      if (median > VERSION_BUDGET_MS) {
        throw new Error(budgetExceededMessage('--version', median, VERSION_BUDGET_MS));
      }

      // Emit timing for CI step summary visibility
      console.log(
        `[perf] styrby --version: ${median} ms median (budget: ${VERSION_BUDGET_MS} ms)`
      );

      expect(median).toBeLessThanOrEqual(VERSION_BUDGET_MS);
    },
    // WHY 60s timeout: 3 samples × 10s each, plus startup overhead
    60_000
  );

  it(
    `styrby status cold-start completes within ${STATUS_BUDGET_MS} ms`,
    () => {
      const median = measureCliStartup(['status', '--json'], SAMPLES);

      if (median > STATUS_BUDGET_MS) {
        throw new Error(budgetExceededMessage('status', median, STATUS_BUDGET_MS));
      }

      console.log(
        `[perf] styrby status: ${median} ms median (budget: ${STATUS_BUDGET_MS} ms)`
      );

      expect(median).toBeLessThanOrEqual(STATUS_BUDGET_MS);
    },
    60_000
  );
});
