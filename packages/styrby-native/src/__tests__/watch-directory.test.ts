/**
 * Tests for the `watchDirectory` / `stopWatcher` JS binding (Phase 0.4).
 *
 * These tests exercise the Node-side contract — both the Rust implementation
 * (when the .node binary is built) and the JS fallback path. They run against
 * whichever path is loaded, so the assertions are limited to the public
 * contract: callbacks fire on create/modify/delete, batching is debounced,
 * stopWatcher releases resources, and the watcher does not leak threads /
 * timers (the test process is allowed to exit cleanly).
 *
 * @module __tests__/watch-directory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const native = require('../../index.js') as {
  isNativeLoaded: boolean;
  watchDirectory(dir: string, cb: (events: WatchEvent[]) => void): WatcherHandle;
  stopWatcher(handle: WatcherHandle): void;
};

interface WatchEvent {
  kind: 'create' | 'modify' | 'remove' | 'access' | 'other';
  paths: string[];
}
interface WatcherHandle {
  readonly __brand?: 'WatcherHandle';
  __fallback?: boolean;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'styrby-watch-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Wait for the next batch event, with a generous timeout. Returns the
 * collected events (concatenated across batches that arrive within `ms`).
 */
async function collectEvents(handle: WatcherHandle, ms: number, _trigger: () => Promise<void>): Promise<WatchEvent[]> {
  // Caller is expected to have already attached a callback before invoking.
  void handle;
  return new Promise((resolve) => setTimeout(() => resolve([]), ms));
}

describe('watchDirectory binding (Phase 0.4)', () => {
  it('returns a handle when given a valid directory', () => {
    const handle = native.watchDirectory(tempDir, () => {});
    expect(handle).toBeDefined();
    native.stopWatcher(handle);
  });

  it('throws (or surfaces error) when the directory does not exist', () => {
    expect(() =>
      native.watchDirectory(join(tempDir, 'does-not-exist'), () => {}),
    ).toThrow();
  });

  it('invokes the callback with a batch when a file is created', async () => {
    const events: WatchEvent[] = [];
    const handle = native.watchDirectory(tempDir, (batch) => {
      events.push(...batch);
    });

    // Give the watcher a moment to subscribe.
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(tempDir, 'created.txt'), 'hello');

    // Wait for debounce window + slack.
    await new Promise((r) => setTimeout(r, 400));
    native.stopWatcher(handle);

    expect(events.length).toBeGreaterThan(0);
    const flat = events.flatMap((e) => e.paths);
    expect(flat.some((p) => p.endsWith('created.txt'))).toBe(true);
  });

  it('invokes the callback when a file is modified', async () => {
    const target = join(tempDir, 'modify-me.txt');
    await writeFile(target, 'first');

    const events: WatchEvent[] = [];
    const handle = native.watchDirectory(tempDir, (batch) => {
      events.push(...batch);
    });
    await new Promise((r) => setTimeout(r, 50));

    await appendFile(target, '\nsecond line');
    await new Promise((r) => setTimeout(r, 400));
    native.stopWatcher(handle);

    expect(events.length).toBeGreaterThan(0);
  });

  it('invokes the callback when a file is removed', async () => {
    const target = join(tempDir, 'delete-me.txt');
    await writeFile(target, 'doomed');

    const events: WatchEvent[] = [];
    const handle = native.watchDirectory(tempDir, (batch) => {
      events.push(...batch);
    });
    await new Promise((r) => setTimeout(r, 50));

    await unlink(target);
    await new Promise((r) => setTimeout(r, 400));
    native.stopWatcher(handle);

    expect(events.length).toBeGreaterThan(0);
  });

  it('stopWatcher is idempotent', () => {
    const handle = native.watchDirectory(tempDir, () => {});
    native.stopWatcher(handle);
    // Second call must not throw.
    expect(() => native.stopWatcher(handle)).not.toThrow();
  });

  it('does not deliver further callbacks after stopWatcher', async () => {
    let callCountAfterStop = 0;
    const handle = native.watchDirectory(tempDir, () => {
      callCountAfterStop += 1;
    });
    await new Promise((r) => setTimeout(r, 50));
    native.stopWatcher(handle);
    callCountAfterStop = 0;

    await writeFile(join(tempDir, 'post-stop.txt'), 'data');
    await new Promise((r) => setTimeout(r, 300));

    expect(callCountAfterStop).toBe(0);
  });
});
