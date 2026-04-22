/**
 * Integration smoke-test harness for Styrby agent factories.
 *
 * Provides `runAgentSmokeTest` and `MockAgentProcess` for replaying
 * pre-recorded stdout fixture sequences through an AgentBackend without
 * spawning a real agent binary.
 *
 * Design goals:
 *   1. Hermetic — zero real subprocesses; works offline and in CI.
 *   2. Configurable replay rate — default 0 ms (synchronous) so tests are
 *      fast; callers may pass intervalMs > 0 for timing tests.
 *   3. Faithfully mimics ChildProcess — stdout/stderr as PassThrough streams,
 *      stdin with a write spy, kill tracking, and the 'close' event.
 *   4. Minimal surface — only what AgentBackend implementations actually read.
 *
 * @module agent/__tests__/integration/harness
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { vi, expect } from 'vitest';
import type { AgentBackend } from '../../core';

// ============================================================================
// MockAgentProcess
// ============================================================================

/**
 * Minimal mock ChildProcess that replays fixture bytes into stdout and fires
 * the 'close' event when done.
 *
 * WHY extend EventEmitter rather than wrap ChildProcess:
 * The factories only need a small slice of ChildProcess — they call
 * `.on('close', ...)`, `.stdout.on('data'|'line', ...)`, `.stderr.on('data', ...)`,
 * and `.kill()`.  Wrapping the real ChildProcess class would pull in the full
 * Node.js child_process machinery (with its `spawn` lifecycle) and leak real
 * processes into tests.  A plain EventEmitter + PassThrough streams satisfies
 * all factory surface area with zero subprocess overhead.
 *
 * WHY PassThrough for stdout/stderr:
 * The readline-based `streamLines()` helper in StreamingAgentBackendBase calls
 * `createInterface({ input: stdout })` which internally calls `.resume()` and
 * registers a 'line' event. PassThrough exposes the full Readable API (unlike
 * a bare EventEmitter) so readline works correctly.  Amp / Droid / OpenCode use
 * `stdout.on('data', ...)` directly — PassThrough satisfies both.
 *
 * WHY track `killed` and `exitCode`:
 * Factory `cancel()` implementations call `process.kill(signal)` and then check
 * `process.killed` in some paths.  Tracking these props mirrors the real
 * ChildProcess state and lets harness assertions verify clean teardown.
 */
export class MockAgentProcess extends EventEmitter {
  /** Readable/writable stdout stream — fed lines by `replay()`. */
  readonly stdout: PassThrough;
  /** Readable/writable stderr stream — empty unless a test writes to it. */
  readonly stderr: PassThrough;
  /** Writable stdin stub with a spy for assertions. */
  readonly stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  /** Set to true after the first `kill()` call. */
  killed = false;
  /** Exit code set in `simulateClose()`. */
  exitCode: number | null = null;
  /** Signal name if closed via signal. */
  killSignal: string | null = null;

  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    // WHY: stdin only needs write() because factories call
    // `this.process.stdin.write(response)` inside `respondToPermission`.
    const stdinEmitter = new EventEmitter() as typeof this.stdin;
    stdinEmitter.write = vi.fn();
    this.stdin = stdinEmitter;
  }

  /**
   * Simulate the process terminating with the given exit code.
   *
   * Closes stdout and stderr (so readline/PassThrough consumers see EOF) then
   * emits 'close'.  Factories resolve/reject their `sendPrompt` promise inside
   * the 'close' handler, so this call drives the full end-to-end path.
   *
   * @param code - Process exit code (0 = success, non-zero = failure)
   */
  simulateClose(code = 0): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  /**
   * Spy-wrapped kill that records the signal and sets `killed = true`.
   *
   * @param signal - Signal name (default 'SIGTERM')
   * @returns Always true (matches ChildProcess.kill() return type)
   */
  kill = vi.fn((signal?: string): boolean => {
    this.killSignal = signal ?? 'SIGTERM';
    this.killed = true;
    return true;
  });
}

// ============================================================================
// Fixture Helpers
// ============================================================================

/**
 * Load a JSONL fixture from disk and return an array of raw line strings.
 *
 * Each non-empty line in the file is one stdout emission.  Empty lines and
 * BOM characters are stripped so fixtures can be hand-authored cleanly.
 *
 * @param fixturePath - Absolute path to the `.jsonl` or `.txt` fixture file
 * @returns Array of non-empty lines ready for replay
 */
export function loadFixture(fixturePath: string): string[] {
  const raw = readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '');
  return raw.split('\n').filter((l) => l.trim().length > 0);
}

// ============================================================================
// SmokeTest Assertions
// ============================================================================

/**
 * Expected-event configuration for a smoke test run.
 */
export interface SmokeTestExpected {
  /** Minimum number of 'model-output' messages required */
  minModelOutputs?: number;
  /** Whether at least one 'cost-report' event is required (default true) */
  requireCostReport?: boolean;
  /** Whether the session should end cleanly (exit code 0, no stuck promise) */
  requireCleanClose?: boolean;
}

// ============================================================================
// RunAgentSmokeTest
// ============================================================================

/**
 * Configuration for `runAgentSmokeTest`.
 */
export interface SmokeTestConfig {
  /**
   * A factory function that accepts a MockAgentProcess and returns a
   * configured AgentBackend.  The factory must call `spawn` (which has been
   * replaced by a vi.mock) internally; the harness supplies the mock process.
   *
   * @example
   * ```ts
   * factory: (proc) => {
   *   mockSpawn.mockReturnValue(proc);
   *   return createAiderBackend({ cwd: '/tmp', model: 'gpt-4' }).backend;
   * }
   * ```
   */
  factory: (proc: MockAgentProcess) => AgentBackend;

  /**
   * Absolute path to the fixture file to replay.
   * Lines are replayed in order into `proc.stdout`.
   */
  fixturePath: string;

  /**
   * Optional assertion overrides.  Defaults: minModelOutputs=1,
   * requireCostReport=true, requireCleanClose=true.
   */
  expected?: SmokeTestExpected;

  /**
   * Delay between replayed stdout lines in milliseconds.
   * Default 0 (synchronous) — pass a positive value for timing tests.
   */
  intervalMs?: number;
}

/**
 * Run an end-to-end smoke test for a single agent factory.
 *
 * Steps:
 *   1. Creates a `MockAgentProcess`.
 *   2. Calls `config.factory(proc)` to build the backend (wiring spawn mock).
 *   3. Registers an `onMessage` collector.
 *   4. Starts `backend.startSession('hello')` which triggers `sendPrompt`.
 *   5. Writes fixture lines into `proc.stdout`.
 *   6. Calls `proc.simulateClose(0)` to fire the 'close' event.
 *   7. Asserts collected messages include expected event types.
 *
 * @param config - Smoke test configuration
 * @returns Collected messages array for additional per-test assertions
 *
 * @example
 * ```ts
 * it('completes a smoke session with cost emission', async () => {
 *   await runAgentSmokeTest({
 *     factory: (proc) => { mockSpawn.mockReturnValue(proc); return backend; },
 *     fixturePath: FIXTURE,
 *   });
 * });
 * ```
 */
export async function runAgentSmokeTest(config: SmokeTestConfig): Promise<unknown[]> {
  const {
    factory,
    fixturePath,
    expected = {},
    intervalMs = 0,
  } = config;

  const {
    minModelOutputs = 1,
    requireCostReport = true,
    requireCleanClose = true,
  } = expected;

  const proc = new MockAgentProcess();
  const backend = factory(proc);

  // Collect all emitted AgentMessages
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));

  // Load fixture lines
  const lines = loadFixture(fixturePath);

  // Start session — this internally calls sendPrompt which spawns (mock) process
  // We don't await yet; the promise resolves when proc closes.
  const sessionPromise = backend.startSession('hello smoke test');

  // Replay stdout lines into the mock process
  for (const line of lines) {
    if (intervalMs > 0) {
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
    // Write line + newline to stdout so readline/data handlers pick it up
    proc.stdout.write(`${line}\n`);
  }

  // Fire the 'close' event to resolve sendPrompt
  proc.simulateClose(0);

  // Await session completion (should resolve cleanly)
  if (requireCleanClose) {
    await expect(sessionPromise).resolves.toMatchObject({ sessionId: expect.any(String) });
  } else {
    await sessionPromise.catch(() => {});
  }

  // ---- Assertions ----------------------------------------------------------

  const modelOutputs = messages.filter(
    (m) => (m as { type: string }).type === 'model-output',
  );
  expect(modelOutputs.length).toBeGreaterThanOrEqual(minModelOutputs);

  if (requireCostReport) {
    const costReports = messages.filter(
      (m) => (m as { type: string }).type === 'cost-report',
    );
    expect(costReports.length).toBeGreaterThanOrEqual(1);
  }

  await backend.dispose();
  return messages;
}

// ============================================================================
// Reconnect Harness Helper
// ============================================================================

/**
 * Replay a portion of a fixture into a backend, then kill the process
 * mid-stream to simulate a disconnect.
 *
 * Used by the reconnect resilience test to verify no double-counting and no
 * stuck promises on restart.
 *
 * @param proc - The MockAgentProcess to write lines into
 * @param lines - All fixture lines
 * @param count - How many lines to write before killing
 */
export function replayPartial(proc: MockAgentProcess, lines: string[], count: number): void {
  const slice = lines.slice(0, count);
  for (const line of slice) {
    proc.stdout.write(`${line}\n`);
  }
}
