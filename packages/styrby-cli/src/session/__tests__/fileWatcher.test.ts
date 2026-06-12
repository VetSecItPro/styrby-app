/**
 * Tests for the project file watcher (session/fileWatcher.ts).
 *
 * Exercises the fs.watch FALLBACK path (the native peer isn't compiled in CI)
 * with a real temp directory, plus the noise filter, debounce batching, and
 * idempotent stop. Top-level file changes are used because Linux fs.watch does
 * not support recursive watching — the fallback degrades to top-level there,
 * and these assertions hold on both recursive (macOS) and non-recursive (Linux)
 * platforms. Recursive-on-Linux is the native backend's job.
 *
 * @module session/__tests__/fileWatcher
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWatcher, DEFAULT_IGNORE, type FileChange, type FileWatcherHandle } from '../fileWatcher';

const handles: FileWatcherHandle[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const h of handles.splice(0)) h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'styrby-fw-'));
  dirs.push(d);
  return d;
}

/** Wait until `predicate()` is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('DEFAULT_IGNORE', () => {
  it('drops dependency / VCS / build / cache paths', () => {
    for (const p of [
      'node_modules/foo/index.js',
      'pkg/node_modules/x.ts',
      '.git/HEAD',
      'dist/bundle.js',
      '.next/cache/x',
      'coverage/lcov.info',
      '.DS_Store',
    ]) {
      expect(DEFAULT_IGNORE.test(p), p).toBe(true);
    }
  });

  it('keeps real source paths', () => {
    for (const p of ['src/index.ts', 'app/page.tsx', 'README.md', 'lib/util.js']) {
      expect(DEFAULT_IGNORE.test(p), p).toBe(false);
    }
  });
});

describe('createFileWatcher — fs.watch fallback', () => {
  it('reports a top-level file change with a dir-relative path', async () => {
    const dir = tempDir();
    const batches: FileChange[][] = [];
    const handle = await createFileWatcher({ dir, onChange: (c) => batches.push(c), debounceMs: 40 });
    handles.push(handle);
    expect(handle.backend === 'fs.watch' || handle.backend === 'none').toBe(true);

    if (handle.backend === 'none') return; // platform without fs.watch — nothing to assert
    writeFileSync(join(dir, 'hello.ts'), 'export const x = 1;');

    const seen = await waitFor(() => batches.flat().some((c) => c.path === 'hello.ts'));
    expect(seen).toBe(true);
    const change = batches.flat().find((c) => c.path === 'hello.ts')!;
    expect(['create', 'modify', 'other']).toContain(change.kind);
  });

  it('debounces rapid changes into a single batch', async () => {
    const dir = tempDir();
    const batches: FileChange[][] = [];
    const handle = await createFileWatcher({ dir, onChange: (c) => batches.push(c), debounceMs: 80 });
    handles.push(handle);
    if (handle.backend === 'none') return;

    writeFileSync(join(dir, 'a.ts'), '1');
    writeFileSync(join(dir, 'b.ts'), '2');

    await waitFor(() => batches.flat().some((c) => c.path === 'a.ts'));
    // Allow the debounce window to settle.
    await new Promise((r) => setTimeout(r, 120));
    const paths = new Set(batches.flat().map((c) => c.path));
    expect(paths.has('a.ts') || paths.has('b.ts')).toBe(true);
    // Both writes happened inside one debounce window → at most a couple batches,
    // never one batch per raw fs event.
    expect(batches.length).toBeLessThanOrEqual(3);
  });

  it('filters out ignored paths (node_modules)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const batches: FileChange[][] = [];
    const handle = await createFileWatcher({ dir, onChange: (c) => batches.push(c), debounceMs: 40 });
    handles.push(handle);
    if (handle.backend === 'none') return;

    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'noise');
    writeFileSync(join(dir, 'real.ts'), 'source');

    await waitFor(() => batches.flat().some((c) => c.path === 'real.ts'));
    await new Promise((r) => setTimeout(r, 80));
    const paths = batches.flat().map((c) => c.path);
    expect(paths).not.toContain('node_modules/junk.js');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('stop() is idempotent and halts delivery', async () => {
    const dir = tempDir();
    const batches: FileChange[][] = [];
    const handle = await createFileWatcher({ dir, onChange: (c) => batches.push(c), debounceMs: 40 });
    handles.push(handle);

    handle.stop();
    expect(() => handle.stop()).not.toThrow(); // idempotent

    if (handle.backend === 'none') return;
    const countAfterStop = batches.flat().length;
    writeFileSync(join(dir, 'after-stop.ts'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(batches.flat().length).toBe(countAfterStop); // no new deliveries
  });
});
