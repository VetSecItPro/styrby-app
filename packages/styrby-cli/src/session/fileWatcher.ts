/**
 * Project file watcher — surfaces file changes during an active session.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@styrby/native` ships a SIMD-fast, debounced, recursive directory watcher
 * (`watchDirectory` / `stopWatcher`, file_watcher.rs) but nothing in the CLI
 * consumed it — the binding was built + tested in isolation. This service is
 * the consumer: it watches a session's project directory and reports batched
 * file changes, so mobile can see what the agent is touching in real time.
 *
 * NATIVE-WITH-FALLBACK (mirrors the jsonl-parser pattern)
 * ------------------------------------------------------
 * `@styrby/native` is an OPTIONAL peer — it may not be compiled for the current
 * platform (e.g. CI without a Rust toolchain). So we try the native watcher
 * first and transparently fall back to Node's `fs.watch`:
 *   - Native: recursive on every platform, OS-debounced, batched.
 *   - Fallback: `fs.watch({ recursive: true })` (macOS/Windows). Linux does NOT
 *     support recursive fs.watch, so there we watch the top level only and note
 *     the limitation — the native watcher is the recursive-on-Linux path.
 * The fallback adds its own debounce so both backends deliver batched changes.
 *
 * NOISE FILTERING
 * ---------------
 * A recursive watch over a project dir would fire constantly on `node_modules`,
 * `.git`, build output, etc. Those are filtered out before `onChange` so the
 * relay (and the mobile UI / battery) only see meaningful source changes.
 *
 * @module session/fileWatcher
 */

import * as fs from 'node:fs';
import { relative, sep } from 'node:path';
import { logger } from '@/ui/logger';

/** A single file change reported to the consumer. */
export interface FileChange {
  /** create | modify | remove (fallback maps fs.watch eventTypes onto these). */
  kind: 'create' | 'modify' | 'remove' | 'other';
  /** Path of the affected file, relative to the watched dir (posix-ish). */
  path: string;
}

/** Options for {@link createFileWatcher}. */
export interface FileWatcherOptions {
  /** Absolute path of the directory to watch. */
  dir: string;
  /** Called with a non-empty batch of changes after debounce/filtering. */
  onChange: (changes: FileChange[]) => void;
  /**
   * Paths matching this are dropped. Defaults to {@link DEFAULT_IGNORE}
   * (node_modules / .git / build output / caches).
   */
  ignore?: RegExp;
  /** Fallback debounce window in ms (native already debounces). Default 150. */
  debounceMs?: number;
}

/** Handle returned by {@link createFileWatcher}. */
export interface FileWatcherHandle {
  /** Stop watching and release OS resources. Idempotent. */
  stop: () => void;
  /** Which backend is active — useful for diagnostics + tests. */
  readonly backend: 'native' | 'fs.watch' | 'none';
}

/**
 * Default ignore pattern: dependency/VCS/build/cache directories that produce
 * high-frequency noise and never represent meaningful agent edits.
 */
export const DEFAULT_IGNORE =
  /(^|[/\\])(node_modules|\.git|dist|build|\.next|\.expo|\.turbo|coverage|\.cache|\.DS_Store)([/\\]|$)/;

/** Minimal shape we use from the optional `@styrby/native` module. */
interface NativeWatchModule {
  isNativeLoaded: boolean;
  watchDirectory: (
    dir: string,
    cb: (events: Array<{ kind: string; paths: string[] }>) => void,
  ) => unknown;
  stopWatcher: (handle: unknown) => void;
}

/** Map a native WatchEvent.kind / fs.watch eventType onto our FileChange.kind. */
function normalizeKind(raw: string): FileChange['kind'] {
  if (raw === 'create' || raw === 'rename') return 'create';
  if (raw === 'modify' || raw === 'change') return 'modify';
  if (raw === 'remove') return 'remove';
  return 'other';
}

/**
 * Start watching `dir` for file changes, preferring the native watcher and
 * falling back to `fs.watch`. Returns a handle whose `stop()` releases the
 * watcher; safe to call once and exactly once per session.
 *
 * @param opts - Watch configuration (dir, onChange, optional ignore/debounce).
 * @returns A handle with `stop()` and the active `backend`.
 *
 * @example
 * const watcher = await createFileWatcher({
 *   dir: session.projectPath,
 *   onChange: (changes) => emitFsEdits(changes),
 * });
 * // ... later, on session end:
 * watcher.stop();
 */
export async function createFileWatcher(opts: FileWatcherOptions): Promise<FileWatcherHandle> {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const debounceMs = opts.debounceMs ?? 150;

  /** Convert an absolute path to a dir-relative, forward-slash path. */
  const toRel = (abs: string): string => relative(opts.dir, abs).split(sep).join('/');

  /** Drop ignored paths; emit only when something survives. */
  const deliver = (changes: FileChange[]): void => {
    const kept = changes.filter((c) => c.path !== '' && !ignore.test(c.path));
    if (kept.length > 0) opts.onChange(kept);
  };

  // ── Native backend (optional peer) ────────────────────────────────────────
  // WHY opt-in via STYRBY_NATIVE_WATCHER: the native module is an optional peer
  // and the watcher spawns OS-level threads. Defaulting to the JS fallback keeps
  // behavior identical on stock installs; operators who built @styrby/native can
  // flip the flag for recursive-on-Linux + SIMD-debounced watching.
  if (process.env.STYRBY_NATIVE_WATCHER === 'true') {
    try {
      // @ts-ignore — @styrby/native is an optional peer; TS2307 is expected.
      const native = (await import('@styrby/native')) as NativeWatchModule;
      if (native.isNativeLoaded && typeof native.watchDirectory === 'function') {
        const handle = native.watchDirectory(opts.dir, (events) => {
          const changes: FileChange[] = [];
          for (const ev of events) {
            for (const p of ev.paths) {
              changes.push({ kind: normalizeKind(ev.kind), path: toRel(p) });
            }
          }
          deliver(changes);
        });
        logger.debug('[FileWatcher] using native backend', { dir: opts.dir });
        let stopped = false;
        return {
          backend: 'native',
          stop: () => {
            if (stopped) return;
            stopped = true;
            try {
              native.stopWatcher(handle);
            } catch (err) {
              logger.debug('[FileWatcher] native stop error (ignored)', { err });
            }
          },
        };
      }
    } catch (err) {
      // Native unavailable — fall through to the JS watcher.
      logger.debug('[FileWatcher] native unavailable, using fs.watch', { err });
    }
  }

  // ── fs.watch fallback (debounced) ─────────────────────────────────────────
  let pending = new Map<string, FileChange['kind']>();
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const batch: FileChange[] = Array.from(pending, ([path, kind]) => ({ path, kind }));
    pending = new Map();
    deliver(batch);
  };

  const onRaw = (eventType: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const path = (typeof filename === 'string' ? filename : filename.toString()).split(sep).join('/');
    // fs.watch can't distinguish create vs modify reliably — 'rename' covers
    // create/delete, 'change' covers modify. We record the latest kind per path.
    pending.set(path, normalizeKind(eventType));
    if (!timer) timer = setTimeout(flush, debounceMs);
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(opts.dir, { persistent: false, recursive: true }, onRaw);
  } catch {
    // Linux: recursive fs.watch is unsupported (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM).
    // Watch the top level only; recursive coverage requires the native backend.
    logger.debug('[FileWatcher] recursive fs.watch unsupported; watching top level only', {
      dir: opts.dir,
    });
    try {
      watcher = fs.watch(opts.dir, { persistent: false, recursive: false }, onRaw);
    } catch (err) {
      logger.debug('[FileWatcher] fs.watch failed; no watcher active', { dir: opts.dir, err });
      return { backend: 'none', stop: () => {} };
    }
  }

  logger.debug('[FileWatcher] using fs.watch backend', { dir: opts.dir });
  let stopped = false;
  return {
    backend: 'fs.watch',
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        watcher.close();
      } catch {
        // already closed
      }
    },
  };
}
