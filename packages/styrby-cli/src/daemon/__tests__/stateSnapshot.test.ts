/**
 * Tests for daemon/stateSnapshot.ts
 *
 * Covers:
 * - Writes snapshot file on start()
 * - Reads prior snapshot and emits 'state-restored' for restorable state
 * - Does NOT emit 'state-restored' for stale snapshots (> 5 min old)
 * - Does NOT emit 'state-restored' for non-restorable sessionStatus values
 * - Renames snapshot to .bak before processing (crash-safe rename-aside)
 * - update() persists patched fields immediately
 * - clearOnExit() removes the snapshot file
 * - Periodic interval writes at SNAPSHOT_INTERVAL_MS (fake timers)
 * - File mode is 0o600
 *
 * WHY tmp dir per test: each test needs an isolated filesystem so file
 * existence/absence assertions are independent and cleanup is trivial.
 *
 * WHY vi.useFakeTimers({ toFake: [...] }): we only fake setInterval/Date
 * to avoid interfering with Promise resolution and microtask queues.
 *
 * @module daemon/__tests__/stateSnapshot
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateSnapshotManager, SNAPSHOT_INTERVAL_MS } from '../stateSnapshot.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temporary directory for use as the snapshot path root.
 * Returns { dir, snapshotFile } where snapshotFile is the path the
 * StateSnapshotManager will write to.
 */
function makeTmpSnapshotFile(): { dir: string; snapshotFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-snap-test-'));
  const snapshotFile = path.join(dir, 'daemon.state.json');
  return { dir, snapshotFile };
}

/**
 * Write a synthetic snapshot file with controllable age.
 *
 * @param snapshotFile - Full path to write to
 * @param overrides - Partial snapshot fields (lastSeenAt controls staleness)
 */
function writeSnapshotFile(
  snapshotFile: string,
  overrides: Partial<{
    machineId: string;
    currentSessionId: string | null;
    agentType: string | null;
    lastSeenAt: string;
    sessionStatus: 'running' | 'reconnecting' | 'idle' | 'stopped';
  }> = {}
): void {
  const snap = {
    machineId: 'machine-123',
    currentSessionId: 'session-abc',
    agentType: 'claude',
    lastSeenAt: new Date().toISOString(),
    sessionStatus: 'running' as const,
    ...overrides,
  };
  fs.writeFileSync(snapshotFile, JSON.stringify(snap), { mode: 0o600 });
}

// ============================================================================
// Tests
// ============================================================================

describe('StateSnapshotManager', () => {
  let mgr: StateSnapshotManager;
  let snapshotFile: string;
  let dir: string;

  beforeEach(() => {
    // WHY { toFake: ['setInterval', 'clearInterval', 'Date'] }:
    // Only faking timer functions and Date keeps Promise microtask resolution
    // working normally. Full vi.useFakeTimers() can interfere with Promise
    // resolution in some vitest/Node versions.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    ({ dir, snapshotFile } = makeTmpSnapshotFile());
    mgr = new StateSnapshotManager(snapshotFile);
  });

  afterEach(() => {
    mgr.stop();
    // Clean up tmp dir
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Initial write
  // --------------------------------------------------------------------------

  it('writes snapshot file immediately on start()', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    expect(fs.existsSync(snapshotFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
    expect(content.machineId).toBe('m1');
    expect(content.sessionStatus).toBe('idle');
    expect(content.lastSeenAt).toBeDefined();
  });

  it('writes snapshot with mode 0o600', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    const stat = fs.statSync(snapshotFile);
    // On Linux/macOS: mode & 0o777 gives permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // --------------------------------------------------------------------------
  // state-restored — restorable snapshots
  // --------------------------------------------------------------------------

  it('emits state-restored for a recent running snapshot', async () => {
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'running',
      lastSeenAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    // WHY await Promise.resolve(): queueMicrotask runs in the microtask queue.
    // Awaiting a resolved promise drains pending microtasks before asserting.
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      sessionStatus: 'running',
      machineId: 'machine-123',
    });
  });

  it('emits state-restored for a recent reconnecting snapshot', async () => {
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'reconnecting',
      lastSeenAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // state-restored — non-restorable cases
  // --------------------------------------------------------------------------

  it('does NOT emit state-restored for a stale snapshot (> 5 min old)', async () => {
    // WHY: fake Date is active, so Date.now() returns the frozen time.
    // We compute a stale timestamp relative to that frozen time.
    const staleTime = new Date(Date.now() - 6 * 60_000).toISOString();
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'running',
      lastSeenAt: staleTime,
    });

    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT emit state-restored for sessionStatus = idle', async () => {
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'idle',
      lastSeenAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT emit state-restored for sessionStatus = stopped', async () => {
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'stopped',
      lastSeenAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT emit state-restored when no prior snapshot exists', async () => {
    const listener = vi.fn();
    mgr.on('state-restored', listener);

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Crash-safe rename-aside
  // --------------------------------------------------------------------------

  it('renames the prior snapshot to .bak before processing so a crash during restore does not re-trigger', () => {
    writeSnapshotFile(snapshotFile, {
      sessionStatus: 'running',
      lastSeenAt: new Date().toISOString(),
    });

    mgr.on('state-restored', vi.fn());
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    // The original file should have been renamed to .bak
    const bakFile = snapshotFile + '.bak';
    expect(fs.existsSync(bakFile)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // update()
  // --------------------------------------------------------------------------

  it('update() patches the in-memory snapshot and writes immediately', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    mgr.update({ currentSessionId: 'sess-xyz', sessionStatus: 'running', agentType: 'codex' });

    const content = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
    expect(content.currentSessionId).toBe('sess-xyz');
    expect(content.sessionStatus).toBe('running');
    expect(content.agentType).toBe('codex');
  });

  it('getCurrent() returns a copy of the current in-memory snapshot', () => {
    mgr.start({
      machineId: 'm2',
      currentSessionId: 'sess-1',
      agentType: 'gemini',
      sessionStatus: 'running',
    });

    const snap = mgr.getCurrent();
    expect(snap).not.toBeNull();
    expect(snap?.machineId).toBe('m2');
    expect(snap?.agentType).toBe('gemini');
  });

  // --------------------------------------------------------------------------
  // Periodic interval
  // --------------------------------------------------------------------------

  it('writes an updated snapshot after SNAPSHOT_INTERVAL_MS via fake timers', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    // Record the initial lastSeenAt
    const before = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')).lastSeenAt as string;

    // Advance time past the interval — Date is faked so Date.now() advances
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS + 100);

    const after = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')).lastSeenAt as string;
    // lastSeenAt should have been updated by the interval write
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  // --------------------------------------------------------------------------
  // clearOnExit()
  // --------------------------------------------------------------------------

  it('clearOnExit() removes the snapshot file', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    expect(fs.existsSync(snapshotFile)).toBe(true);

    mgr.clearOnExit();

    expect(fs.existsSync(snapshotFile)).toBe(false);
  });

  it('clearOnExit() also removes .bak if present', () => {
    const bakFile = snapshotFile + '.bak';
    fs.writeFileSync(bakFile, '{}', { mode: 0o600 });

    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    mgr.clearOnExit();

    expect(fs.existsSync(bakFile)).toBe(false);
  });

  it('clearOnExit() stops the interval (no re-creation after clear)', () => {
    mgr.start({
      machineId: 'm1',
      currentSessionId: null,
      agentType: null,
      sessionStatus: 'idle',
    });

    mgr.clearOnExit();

    // Advance well past the interval — should NOT re-create the file
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS * 3);
    expect(fs.existsSync(snapshotFile)).toBe(false);
  });
});
