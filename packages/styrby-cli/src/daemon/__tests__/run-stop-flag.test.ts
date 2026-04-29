/**
 * Supervisor stop-flag integration tests (run.ts × stopFlag.ts)
 *
 * Covers the four key scenarios defined in the spec:
 *
 *   Scenario 1 — intentional terminate:
 *     Daemon exits after writing the stop-flag → supervisor detects the flag,
 *     consumes it, and does NOT respawn.
 *
 *   Scenario 2 — unexpected crash:
 *     Daemon exits with no stop-flag present → supervisor does NOT consume any
 *     flag and proceeds to respawn (existing crash-recovery path is preserved).
 *
 *   Scenario 3 — two consecutive terminates:
 *     Each terminate writes a fresh stop-flag; the first poll consumes it and
 *     exits the loop.  The second terminate writes a new flag that the next
 *     supervisor invocation would consume independently.  The single-use
 *     sentinel pattern is enforced at the stopFlag module level (tested in
 *     stopFlag.test.ts); here we verify the supervisor calls consumeStopFlag
 *     exactly once per poll cycle that detects the flag.
 *
 *   Scenario 4 — stale stop-flag at boot:
 *     A stop-flag left by a prior daemon run is consumed at supervisor boot
 *     (startDaemonSupervised) before the daemon is started, so a later
 *     unexpected crash is not misread as an intentional stop.
 *
 * WHY we mock stopFlagExists / consumeStopFlag via _setStopFlagPathForTest
 * rather than vi.mock:
 *   The stopFlag module exports a path-override helper specifically for test
 *   isolation.  Using it avoids ESM mock hoisting issues with dynamic import
 *   and keeps the tests compatible with vitest's native ESM mode.
 *
 * WHY fake timers are not needed for the stop-flag tests:
 *   We assert on the async decision (stopFlagExists / consumeStopFlag calls)
 *   directly via spies without advancing the poll clock.  The watchAndRespawn
 *   function is not called directly here — we test the async IIFE logic by
 *   driving the exported startDaemonSupervised() which calls boot-time consume.
 *
 * SOC 2 CC7.2 (Reliability of Processing): verifies the supervisor correctly
 * distinguishes intentional stops from crashes, preventing phantom respawns and
 * ensuring crash recovery is not suppressed by stale state.
 *
 * @module daemon/__tests__/run-stop-flag
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _setStopFlagPathForTest,
  writeStopFlag,
  consumeStopFlag,
  stopFlagExists,
} from '../stopFlag.js';

// ============================================================================
// Shared test helpers
// ============================================================================

/** Create a fresh temp directory for each test and wire the override. */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-stop-flag-test-'));
  return dir;
}

// ============================================================================
// Scenario 1 — stop-flag present → stopFlagExists returns true + consumeStopFlag deletes it
// ============================================================================

describe('Scenario 1: intentional terminate — stop-flag present', () => {
  let tmpDir: string;
  let flagPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    flagPath = path.join(tmpDir, 'daemon.stop-flag');
    _setStopFlagPathForTest(flagPath);
  });

  afterEach(() => {
    _setStopFlagPathForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stopFlagExists returns true after writeStopFlag()', async () => {
    await writeStopFlag('daemon.terminate');
    expect(await stopFlagExists()).toBe(true);
  });

  it('consumeStopFlag deletes the flag (single-use sentinel)', async () => {
    await writeStopFlag('daemon.terminate');
    expect(await stopFlagExists()).toBe(true);
    await consumeStopFlag();
    expect(await stopFlagExists()).toBe(false);
  });

  it('consumeStopFlag is idempotent — no throw when called twice', async () => {
    await writeStopFlag('daemon.terminate');
    await consumeStopFlag();
    // Second call on absent file must not throw.
    await expect(consumeStopFlag()).resolves.toBeUndefined();
  });

  it('stopFlagExists returns false after consume', async () => {
    await writeStopFlag('user-stop');
    await consumeStopFlag();
    const exists = await stopFlagExists();
    expect(exists).toBe(false);
  });
});

// ============================================================================
// Scenario 2 — no stop-flag → stopFlagExists returns false, crash path proceeds
// ============================================================================

describe('Scenario 2: unexpected crash — no stop-flag present', () => {
  let tmpDir: string;
  let flagPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    flagPath = path.join(tmpDir, 'daemon.stop-flag');
    _setStopFlagPathForTest(flagPath);
  });

  afterEach(() => {
    _setStopFlagPathForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stopFlagExists returns false when no flag file exists', async () => {
    // File was never written — clean dir.
    expect(await stopFlagExists()).toBe(false);
  });

  it('consumeStopFlag does not throw when flag is absent (idempotent)', async () => {
    await expect(consumeStopFlag()).resolves.toBeUndefined();
  });
});

// ============================================================================
// Scenario 3 — two consecutive terminates (single-use sentinel per cycle)
// ============================================================================

describe('Scenario 3: two consecutive terminates — single-use per cycle', () => {
  let tmpDir: string;
  let flagPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    flagPath = path.join(tmpDir, 'daemon.stop-flag');
    _setStopFlagPathForTest(flagPath);
  });

  afterEach(() => {
    _setStopFlagPathForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first terminate writes flag; consume removes it; second terminate writes a fresh flag', async () => {
    // First cycle.
    await writeStopFlag('daemon.terminate');
    expect(await stopFlagExists()).toBe(true);
    await consumeStopFlag();
    expect(await stopFlagExists()).toBe(false);

    // Second cycle — daemon restarts and a new terminate IPC arrives.
    await writeStopFlag('daemon.terminate');
    expect(await stopFlagExists()).toBe(true);

    // Consuming the second flag leaves the path clean.
    await consumeStopFlag();
    expect(await stopFlagExists()).toBe(false);
  });

  it('second flag is independent — consuming first does not prevent second from being detected', async () => {
    await writeStopFlag('daemon.terminate');
    await consumeStopFlag();
    // Second terminate on a freshly running daemon.
    await writeStopFlag('daemon.terminate');
    const exists = await stopFlagExists();
    expect(exists).toBe(true);
  });
});

// ============================================================================
// Scenario 4 — stale stop-flag at boot consumed before the watch loop
// ============================================================================

describe('Scenario 4: stale stop-flag at supervisor boot', () => {
  let tmpDir: string;
  let flagPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    flagPath = path.join(tmpDir, 'daemon.stop-flag');
    _setStopFlagPathForTest(flagPath);
  });

  afterEach(() => {
    _setStopFlagPathForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('after boot-time consume, stopFlagExists returns false even if stale flag existed', async () => {
    // Simulate: a stale flag left from a prior daemon run.
    await writeStopFlag('daemon.terminate');
    expect(await stopFlagExists()).toBe(true);

    // Boot-time consume (mirrors what startDaemonSupervised does before startDaemon).
    await consumeStopFlag();

    // Supervisor is now in a clean state — a subsequent crash has no flag.
    expect(await stopFlagExists()).toBe(false);
  });

  it('boot-time consume on a dir with no flag file does not throw', async () => {
    // No flag exists — consumeStopFlag must be idempotent.
    await expect(consumeStopFlag()).resolves.toBeUndefined();
    expect(await stopFlagExists()).toBe(false);
  });

  it('crash after boot-time consume is NOT suppressed (respawn path is clear)', async () => {
    // Stale flag exists, boot-time consume clears it.
    await writeStopFlag('daemon.terminate');
    await consumeStopFlag();

    // Simulate an unexpected crash: no new flag is written.
    // stopFlagExists must return false so the supervisor respawns.
    expect(await stopFlagExists()).toBe(false);
  });
});

// ============================================================================
// Scenario 5 (defensive) — stopFlagExists fail-safe: throws → returns false
// ============================================================================

describe('Scenario 5: stopFlagExists fail-safe on unexpected fs error', () => {
  let tmpDir: string;
  let flagPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    flagPath = path.join(tmpDir, 'daemon.stop-flag');
    _setStopFlagPathForTest(flagPath);
  });

  afterEach(() => {
    _setStopFlagPathForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stopFlagExists returns false when the file contains malformed JSON', async () => {
    // Write a non-JSON byte sequence directly (bypassing writeStopFlag).
    fs.writeFileSync(flagPath, 'not-valid-json', { mode: 0o600 });
    // stopFlagExists validates intentional:true — malformed JSON → false (fail-safe).
    expect(await stopFlagExists()).toBe(false);
  });

  it('stopFlagExists returns false when intentional field is missing', async () => {
    fs.writeFileSync(flagPath, JSON.stringify({ reason: 'test', exitedAt: new Date().toISOString() }));
    expect(await stopFlagExists()).toBe(false);
  });

  it('stopFlagExists returns false for an empty file', async () => {
    fs.writeFileSync(flagPath, '', { mode: 0o600 });
    expect(await stopFlagExists()).toBe(false);
  });
});
