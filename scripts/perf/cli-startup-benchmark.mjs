#!/usr/bin/env node
/**
 * CLI startup-time performance budget benchmark.
 *
 * Measures two commands that run on every developer machine and in CI:
 *   - `styrby --version`  target median ≤ 150 ms  (fast-path; no I/O)
 *   - `styrby status`     target median ≤ 500 ms  (reads local config)
 *
 * WHY these thresholds:
 *   150 ms is the human perception threshold for "instant" feedback
 *   (Nielsen's 0.1 s rule, widely adopted in CLI tooling SLOs). Exceeding it
 *   on `--version` almost always indicates a Node.js startup regression
 *   (e.g. a large synchronous `require` added to the critical path).
 *
 *   500 ms for `status` matches the threshold used by tools like `git status`
 *   and `gh status` — crossing it makes the CLI feel sluggish for the
 *   common "what's running?" workflow.
 *
 * Runs each command RUNS_PER_COMMAND times (default 10), discards the first
 * warm-up run to avoid one-time JIT outliers, then reports median + P95.
 * Exits non-zero if either median breaches its threshold.
 *
 * Usage:
 *   node scripts/perf/cli-startup-benchmark.mjs
 *   # Override thresholds for testing:
 *   VERSION_THRESHOLD_MS=500 STATUS_THRESHOLD_MS=2000 node scripts/perf/cli-startup-benchmark.mjs
 *
 * @module scripts/perf/cli-startup-benchmark
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// ─── Configuration ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/** Number of timed runs per command (first run is a warm-up and discarded). */
const RUNS_PER_COMMAND = parseInt(process.env.RUNS_PER_COMMAND ?? '10', 10);

/**
 * Median budget for `styrby --version`.
 * Env override: VERSION_THRESHOLD_MS (used in tests to avoid false failures
 * in slow CI runners where we just want to verify the script logic).
 */
const VERSION_THRESHOLD_MS = parseInt(
  process.env.VERSION_THRESHOLD_MS ?? '150',
  10,
);

/**
 * Median budget for `styrby status`.
 * Env override: STATUS_THRESHOLD_MS
 */
const STATUS_THRESHOLD_MS = parseInt(
  process.env.STATUS_THRESHOLD_MS ?? '500',
  10,
);

// ─── Resolve CLI binary ───────────────────────────────────────────────────────

/**
 * Resolves the path to the Styrby CLI binary.
 *
 * Prefers the compiled `dist/index.js` (production path used by CI after
 * `build-cli` completes). Falls back to the dev `bin/styrby.mjs` shim
 * (which forwards to `dist/` anyway — still useful for a quick smoke run).
 *
 * @returns Absolute path to the CLI entry point.
 * @throws {Error} If neither path exists (CLI not built).
 */
function resolveCliBinary() {
  const distEntry = resolve(REPO_ROOT, 'packages', 'styrby-cli', 'dist', 'index.js');
  const binShim   = resolve(REPO_ROOT, 'packages', 'styrby-cli', 'bin', 'styrby.mjs');

  if (existsSync(distEntry)) return distEntry;
  if (existsSync(binShim))   return binShim;

  throw new Error(
    'Styrby CLI binary not found. Run `pnpm --filter styrby-cli build` first.\n' +
    `  Checked: ${distEntry}\n` +
    `           ${binShim}`,
  );
}

// ─── Measurement helpers ──────────────────────────────────────────────────────

/**
 * Runs a single CLI invocation and returns elapsed wall-clock time in ms.
 *
 * Uses `execFileSync` (not `spawnSync`) so the process is exec'd directly
 * without an intermediate shell — this avoids counting shell startup time
 * in the measurement.
 *
 * @param cliPath  - Absolute path to the CLI entry point.
 * @param args     - CLI arguments to pass (e.g. `['--version']`).
 * @returns Elapsed time in milliseconds.
 */
function measureOneRun(cliPath, args) {
  const start = performance.now();
  try {
    execFileSync(process.execPath, [cliPath, ...args], {
      // Suppress all output — we only care about timing.
      stdio: 'ignore',
      // Allow the process to exit non-zero (e.g. `status` may 401 in CI
      // without real Supabase creds — we still want the timing).
      encoding: 'buffer',
    });
  } catch {
    // Non-zero exit is acceptable — the command ran, we have a timing.
  }
  return performance.now() - start;
}

/**
 * Runs a command RUNS_PER_COMMAND times, discards the first (warm-up),
 * and returns median + P95 of the remaining samples.
 *
 * @param label    - Human-readable name for logging (e.g. "styrby --version").
 * @param cliPath  - Absolute path to the CLI entry point.
 * @param args     - CLI arguments to benchmark.
 * @returns `{ median, p95, samples }` — times in milliseconds.
 */
function benchmarkCommand(label, cliPath, args) {
  console.log(`\nBenchmarking: ${label} (${RUNS_PER_COMMAND} runs, first discarded as warm-up)`);

  const allSamples = [];
  for (let i = 0; i < RUNS_PER_COMMAND; i++) {
    const ms = measureOneRun(cliPath, args);
    allSamples.push(ms);
    process.stdout.write(i === 0 ? `  [warm-up] ${ms.toFixed(1)} ms\n` : `  [run ${i}] ${ms.toFixed(1)} ms\n`);
  }

  // Discard warm-up run (index 0).
  const samples = allSamples.slice(1).sort((a, b) => a - b);

  const median = percentile(samples, 50);
  const p95    = percentile(samples, 95);

  return { median, p95, samples };
}

/**
 * Computes a percentile value from a sorted array.
 *
 * Uses nearest-rank method (common in performance tooling).
 *
 * @param sorted - Array of numbers sorted ascending.
 * @param pct    - Percentile 0–100.
 * @returns Value at the given percentile.
 */
function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[idx];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Entry point: runs both benchmarks and exits non-zero on budget breach.
 *
 * @returns Promise that resolves when benchmarks are complete.
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Styrby CLI Startup Performance Budget');
  console.log('='.repeat(60));
  console.log(`Thresholds: --version ≤ ${VERSION_THRESHOLD_MS} ms median | status ≤ ${STATUS_THRESHOLD_MS} ms median`);

  let cliBinary;
  try {
    cliBinary = resolveCliBinary();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
  console.log(`CLI binary: ${cliBinary}`);

  // ── styrby --version ────────────────────────────────────────────────────────
  const versionResult = benchmarkCommand('styrby --version', cliBinary, ['--version']);

  // ── styrby status ───────────────────────────────────────────────────────────
  const statusResult = benchmarkCommand('styrby status', cliBinary, ['status']);

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('Results');
  console.log('='.repeat(60));

  const versionPass = versionResult.median <= VERSION_THRESHOLD_MS;
  const statusPass  = statusResult.median  <= STATUS_THRESHOLD_MS;

  const fmt = (label, result, threshold, pass) =>
    `${pass ? '✓' : '✗'} ${label.padEnd(20)}  median ${result.median.toFixed(1).padStart(7)} ms  P95 ${result.p95.toFixed(1).padStart(7)} ms  (budget: ${threshold} ms)`;

  console.log(fmt('styrby --version', versionResult, VERSION_THRESHOLD_MS, versionPass));
  console.log(fmt('styrby status',    statusResult,  STATUS_THRESHOLD_MS,  statusPass));

  // ── GitHub Actions Step Summary ─────────────────────────────────────────────
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { writeFileSync, appendFileSync } = await import('node:fs');
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;

    const lines = [
      '',
      '## CLI Startup Performance Budget',
      '',
      '| Command | Median | P95 | Budget | Status |',
      '|---------|--------|-----|--------|--------|',
      `| \`styrby --version\` | ${versionResult.median.toFixed(1)} ms | ${versionResult.p95.toFixed(1)} ms | ${VERSION_THRESHOLD_MS} ms | ${versionPass ? ':white_check_mark:' : ':x: OVER BUDGET'} |`,
      `| \`styrby status\` | ${statusResult.median.toFixed(1)} ms | ${statusResult.p95.toFixed(1)} ms | ${STATUS_THRESHOLD_MS} ms | ${statusPass ? ':white_check_mark:' : ':x: OVER BUDGET'} |`,
      '',
    ];
    appendFileSync(summaryPath, lines.join('\n') + '\n');
  }

  if (!versionPass || !statusPass) {
    console.error('\n✗ CLI startup performance budget EXCEEDED.');
    if (!versionPass) {
      console.error(`  styrby --version: ${versionResult.median.toFixed(1)} ms median > ${VERSION_THRESHOLD_MS} ms budget`);
    }
    if (!statusPass) {
      console.error(`  styrby status: ${statusResult.median.toFixed(1)} ms median > ${STATUS_THRESHOLD_MS} ms budget`);
    }
    process.exit(1);
  }

  console.log('\n✓ All CLI startup budgets met.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
