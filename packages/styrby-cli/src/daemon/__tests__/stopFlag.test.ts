/**
 * Tests for daemon/stopFlag.ts
 *
 * Covers all 6 spec scenarios:
 *
 * 1. writeStopFlag() writes JSON with intentional:true, reason, and parseable ISO timestamp
 * 2. stopFlagExists() returns true after a write, false before any write
 * 3. consumeStopFlag() deletes the file; stopFlagExists() then returns false
 * 4. consumeStopFlag() is idempotent — no error if file already absent
 * 5. writeStopFlag() resolves silently on fs write failure — logs warn, no throw escapes
 * 6. stopFlagExists() returns false for malformed JSON (fail-safe to "no flag")
 *
 * WHY tmp dir per test + _setStopFlagPathForTest:
 *   Node ESM module namespaces are not configurable — vi.spyOn cannot patch
 *   os.homedir() in ESM mode. Instead stopFlag.ts exposes a test-only setter
 *   (_setStopFlagPathForTest) that redirects all three helpers to an isolated
 *   tmp path, mirroring StateSnapshotManager's constructor-param pattern.
 *   This gives full filesystem isolation without touching the real ~/.styrby/.
 *
 * @module daemon/__tests__/stopFlag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeStopFlag,
  stopFlagExists,
  consumeStopFlag,
  getStopFlagPath,
  _setStopFlagPathForTest,
} from '../stopFlag.js';
import { logger } from '../../ui/logger.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create an isolated tmp directory and return the path that will be used as
 * the stop-flag file within it. Does NOT create the .styrby subdirectory —
 * writeStopFlag() is responsible for mkdir.
 */
function makeTmpStopFlagFile(): { dir: string; stopFlagFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-stopflag-test-'));
  const stopFlagFile = path.join(dir, 'daemon.stop-flag');
  return { dir, stopFlagFile };
}

// ============================================================================
// Tests
// ============================================================================

describe('stopFlag', () => {
  let dir: string;
  let stopFlagFile: string;

  beforeEach(() => {
    ({ dir, stopFlagFile } = makeTmpStopFlagFile());
    // Redirect all three helpers to the isolated tmp file.
    _setStopFlagPathForTest(stopFlagFile);
  });

  afterEach(() => {
    // Restore default path so other test files are not affected.
    _setStopFlagPathForTest(undefined);
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --------------------------------------------------------------------------
  // 1. writeStopFlag writes valid JSON payload
  // --------------------------------------------------------------------------
  it('scenario 1 — writes JSON with intentional:true, reason, and parseable ISO timestamp', async () => {
    const before = Date.now();

    await writeStopFlag('daemon.terminate');

    expect(fs.existsSync(stopFlagFile)).toBe(true);

    const raw = fs.readFileSync(stopFlagFile, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.intentional).toBe(true);
    expect(parsed.reason).toBe('daemon.terminate');
    expect(typeof parsed.exitedAt).toBe('string');

    const ts = new Date(parsed.exitedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  // --------------------------------------------------------------------------
  // 2. stopFlagExists() returns true after write, false before
  // --------------------------------------------------------------------------
  it('scenario 2 — stopFlagExists returns false before write and true after', async () => {
    expect(await stopFlagExists()).toBe(false);

    await writeStopFlag('test-reason');

    expect(await stopFlagExists()).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. consumeStopFlag deletes the file
  // --------------------------------------------------------------------------
  it('scenario 3 — consumeStopFlag deletes the file; stopFlagExists then returns false', async () => {
    await writeStopFlag('user-stop');
    expect(await stopFlagExists()).toBe(true);

    await consumeStopFlag();
    expect(await stopFlagExists()).toBe(false);
    expect(fs.existsSync(stopFlagFile)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 4. consumeStopFlag is idempotent
  // --------------------------------------------------------------------------
  it('scenario 4 — consumeStopFlag resolves without error if file is already absent', async () => {
    // File never written — first call should not throw.
    await expect(consumeStopFlag()).resolves.toBeUndefined();

    // Second call also fine.
    await expect(consumeStopFlag()).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // 5. writeStopFlag resolves silently on fs write failure
  // --------------------------------------------------------------------------
  it('scenario 5 — writeStopFlag resolves silently and logs warn on fs failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    // Make writeFile throw to simulate a filesystem failure (e.g., permission denied).
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    // Must resolve (not reject) despite the fs failure.
    await expect(writeStopFlag('test-fail')).resolves.toBeUndefined();

    // Must log a warning.
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/stop-flag/i);
  });

  // --------------------------------------------------------------------------
  // 6. stopFlagExists returns false for malformed JSON
  // --------------------------------------------------------------------------
  it('scenario 6 — stopFlagExists returns false if file contains malformed JSON', async () => {
    // Write garbage content directly (bypassing writeStopFlag).
    fs.mkdirSync(path.dirname(stopFlagFile), { recursive: true });
    fs.writeFileSync(stopFlagFile, 'this is not valid json {{{}}}');

    // Must fail-safe to false rather than throwing or returning true.
    expect(await stopFlagExists()).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Additional: getStopFlagPath returns the overridden path in tests
  // --------------------------------------------------------------------------
  it('getStopFlagPath returns the test-overridden path', () => {
    const p = getStopFlagPath();
    expect(p).toBe(stopFlagFile);
    expect(p).toContain('daemon.stop-flag');
  });
});
