/**
 * @styrby/native — TypeScript declarations
 *
 * Type definitions for the native Rust module and its JS fallback layer.
 * Import this package from styrby-cli to use the high-performance JSONL
 * parser with automatic fallback to the pure-JS implementation.
 *
 * @example
 * ```ts
 * import { parseJsonlFileBatch, isNativeLoaded } from '@styrby/native';
 *
 * if (isNativeLoaded) {
 *   console.log('Using Rust SIMD parser');
 * }
 *
 * const records = await parseJsonlFileBatch('/path/to/session.jsonl');
 * console.log(`Parsed ${records.length} usage records`);
 * ```
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Token usage extracted from a single JSONL line.
 *
 * Mirrors the `TokenUsage` interface in
 * `packages/styrby-cli/src/costs/jsonl-parser.ts` with snake_case field names
 * (the Rust struct fields are serialised as-is by napi-rs).
 */
export interface NativeTokenUsage {
  /** Tokens sent to the model (user prompts + context). */
  input_tokens: number;
  /** Tokens received from the model (response content). */
  output_tokens: number;
  /** Tokens read from the prompt cache (don't count against full price). */
  cache_read_tokens: number;
  /** Tokens written to the prompt cache. */
  cache_write_tokens: number;
  /** Model identifier (e.g., `"claude-sonnet-4-20250514"`). */
  model: string;
  /** ISO 8601 timestamp from the JSONL event, or current time if absent. */
  timestamp: string;
}

/**
 * A single debounced file system event delivered to the watchDirectory callback.
 */
export interface WatchEvent {
  /**
   * Event type:
   * - `"create"` — file or directory created
   * - `"modify"` — file contents or metadata changed
   * - `"remove"` — file or directory removed
   * - `"access"` — file read (not emitted on all platforms)
   * - `"other"` — platform-specific event not covered above
   */
  kind: 'create' | 'modify' | 'remove' | 'access' | 'other';
  /** Absolute paths of affected files. May be empty on some platforms. */
  paths: string[];
}

/**
 * Opaque handle for a running file watcher.
 * Pass to `stopWatcher()` to release OS resources.
 */
export interface WatcherHandle {
  readonly __brand: 'WatcherHandle';
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

/**
 * `true` when the native Rust `.node` binary is loaded and active.
 * `false` when running on the pure-JS fallback path.
 */
export declare const isNativeLoaded: boolean;

/**
 * Version of the loaded implementation.
 * - Native: semver string (e.g., `"0.1.0"`)
 * - Fallback: `"js-fallback"`
 */
export declare const version: string;

/**
 * Parses a JSONL file and emits each `TokenUsage` record to a callback.
 *
 * The native implementation is synchronous and blocks the calling thread for
 * the duration of the file I/O + parse. The JS fallback is async (returns a
 * Promise). Always `await` this function for compatibility with both paths.
 *
 * @param filePath - Absolute path to the `.jsonl` file
 * @param callback - Called once per usage record found in the file
 * @returns `void` (native) or `Promise<void>` (JS fallback)
 */
export declare function parseJsonlFileStream(
  filePath: string,
  callback: (record: NativeTokenUsage) => void
): void | Promise<void>;

/**
 * Parses an entire JSONL file and returns all `TokenUsage` records as an array.
 *
 * The native implementation uses Rayon parallel processing across all CPU
 * cores. The JS fallback uses the sequential readline parser.
 *
 * @param filePath - Absolute path to the `.jsonl` file
 * @returns Array of usage records (native: synchronous, fallback: `Promise`)
 */
export declare function parseJsonlFileBatch(
  filePath: string
): NativeTokenUsage[] | Promise<NativeTokenUsage[]>;

/**
 * Starts watching a directory for file system changes.
 *
 * Uses platform-native APIs (FSEvents / inotify / ReadDirectoryChangesW) via
 * the Rust `notify` crate. Events are debounced into 100 ms batches.
 *
 * **Requires the native Rust module.** Throws if native is not loaded.
 *
 * @param dirPath - Absolute path to the directory to watch (recursive)
 * @param callback - Called with batched `WatchEvent[]` arrays after debounce
 * @returns A `WatcherHandle` — pass to `stopWatcher()` to clean up
 * @throws {Error} If the native module is not loaded or the path is invalid
 */
export declare function watchDirectory(
  dirPath: string,
  callback: (events: WatchEvent[]) => void
): WatcherHandle;

/**
 * Stops a running file watcher and releases OS resources.
 *
 * @param handle - The `WatcherHandle` returned by `watchDirectory()`
 * @throws {Error} If the native module is not loaded
 */
export declare function stopWatcher(handle: WatcherHandle): void;
