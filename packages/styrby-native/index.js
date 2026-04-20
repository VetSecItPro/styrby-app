/**
 * @styrby/native — JavaScript entry point with JS fallback
 *
 * Attempts to load the compiled Rust `.node` binary for the current platform.
 * If the binary is not available (e.g., not compiled, unsupported platform,
 * first-time install), falls back to a self-contained pure-JS JSONL parser
 * so the CLI continues to work everywhere without a Rust toolchain.
 *
 * ## Load order
 *
 * 1. Try `styrby-native.<platform>-<arch>.node` (compiled native binary)
 * 2. Fall back to built-in JS parser (always available, no build step required)
 *
 * ## Environment variables
 *
 * - `STYRBY_NATIVE_PARSER=true` — (checked by the CLI integration layer, not
 *   here) opts into the native parser when the binary is available.
 * - `STYRBY_NATIVE_DEBUG=true` — logs the load result to stderr for debugging.
 *
 * @module @styrby/native
 */

'use strict';

const fs = require('fs');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Resolves the expected filename of the pre-compiled `.node` binary for the
 * current platform and architecture.
 *
 * napi-rs names binaries:  `<crate-name>.<triple>.node`
 * e.g.: `styrby-native.darwin-arm64.node`
 *
 * @returns {string|null} Expected .node filename, or null if platform is unsupported.
 */
function nativeBinaryName() {
  const { platform, arch } = process;

  /** @type {Record<string, Record<string, string>>} */
  const triples = {
    darwin: {
      arm64: 'darwin-arm64',
      x64:   'darwin-x64',
    },
    linux: {
      x64: 'x64-linux-gnu',
    },
    win32: {
      x64: 'win32-x64-msvc',
    },
  };

  const archMap = triples[platform];
  if (!archMap) return null;

  const triple = archMap[arch];
  if (!triple) return null;

  return `styrby-native.${triple}.node`;
}

// ---------------------------------------------------------------------------
// Native module loader
// ---------------------------------------------------------------------------

/**
 * Attempts to `require()` the native `.node` binary.
 *
 * Returns the module exports if successful, or null if the binary is missing
 * or fails to load (e.g., ABI mismatch, missing shared library).
 *
 * @returns {object|null} Native module exports, or null on failure.
 */
function tryLoadNative() {
  const filename = nativeBinaryName();
  if (!filename) return null;

  try {
    const path = require('path');
    const native = require(path.join(__dirname, filename));
    if (process.env.STYRBY_NATIVE_DEBUG) {
      process.stderr.write(`[styrby-native] Loaded native module: ${filename}\n`);
    }
    return native;
  } catch (/** @type {any} */ err) {
    if (process.env.STYRBY_NATIVE_DEBUG) {
      process.stderr.write(
        `[styrby-native] Native module not available (${filename}): ${err.message}\n` +
        `[styrby-native] Falling back to JS parser.\n`
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Self-contained JS fallback parser
//
// WHY: The CLI is bundled by esbuild into dist/index.js and dist/lib.js —
// individual module files like dist/costs/index.js do not exist. Instead of
// trying to import from the bundle (which would pull in the entire CLI), we
// embed a minimal self-contained JSONL parser here. It handles the same two
// formats as the TS reference parser in jsonl-parser.ts.
// ---------------------------------------------------------------------------

/**
 * Parses a single JSONL line and returns a NativeTokenUsage-shaped object
 * or null if the line contains no usage data.
 *
 * Handles both formats:
 * - Format 1: `{"type":"assistant","message":{"model":"...","usage":{...}}}`
 * - Format 2: `{"cost_info":{"model":"...","input_tokens":...}}`
 *
 * @param {string} line - A single line from a .jsonl file
 * @returns {{ input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, model: string, timestamp: string }|null}
 */
function parseLineJS(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;

  /** @type {any} */
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Format 1: assistant message with nested usage
  if (data.type === 'assistant' && data.message && data.message.usage) {
    const u = data.message.usage;
    return {
      input_tokens:      (u.input_tokens              || 0),
      output_tokens:     (u.output_tokens             || 0),
      cache_read_tokens: (u.cache_read_input_tokens   || 0),
      cache_write_tokens:(u.cache_creation_input_tokens || 0),
      model:             data.message.model           || 'unknown',
      timestamp:         data.timestamp               || new Date().toISOString(),
    };
  }

  // Format 2: cost_info top-level field
  if (data.cost_info) {
    const ci = data.cost_info;
    return {
      input_tokens:      (ci.input_tokens       || 0),
      output_tokens:     (ci.output_tokens      || 0),
      cache_read_tokens: (ci.cache_read_tokens  || 0),
      cache_write_tokens:(ci.cache_write_tokens || 0),
      model:             ci.model               || 'unknown',
      timestamp:         data.timestamp         || new Date().toISOString(),
    };
  }

  return null;
}

/**
 * JS fallback for parseJsonlFileStream — reads the file line by line using
 * Node.js `readline` and calls `callback` for each usage record found.
 *
 * @param {string} filePath - Absolute path to the .jsonl file
 * @param {function(object): void} callback - Called for each TokenUsage record
 * @returns {Promise<void>}
 */
async function parseJsonlFileStreamFallback(filePath, callback) {
  if (!fs.existsSync(filePath)) return;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const record = parseLineJS(line);
    if (record) {
      callback(record);
    }
  }
}

/**
 * JS fallback for parseJsonlFileBatch — reads the entire file and returns
 * all usage records as an array.
 *
 * @param {string} filePath - Absolute path to the .jsonl file
 * @returns {Promise<object[]>} Array of NativeTokenUsage-shaped records
 */
async function parseJsonlFileBatchFallback(filePath) {
  const records = [];
  await parseJsonlFileStreamFallback(filePath, (r) => records.push(r));
  return records;
}

/**
 * JS fallback stub for nativeVersion — returns a sentinel string that
 * indicates the native module is not loaded.
 *
 * @returns {string} Sentinel version string
 */
function nativeVersionFallback() {
  return 'js-fallback';
}

/**
 * JS fallback for watchDirectory using `fs.watch` (Phase 0.4).
 *
 * WHY: The native Rust watcher is the preferred path (low latency, kernel
 * notification APIs). When the .node binary is unavailable (CI, pre-build,
 * unsupported triple), we still need watch support so the CLI session
 * tracker keeps working. Node's `fs.watch` has known cross-platform quirks
 * but is sufficient for the session-watcher use case and lets the integration
 * tests in this package run without the Rust toolchain.
 *
 * Behavioral parity with the native module:
 * - Recursive watching (Node supports `recursive: true` on darwin/win32; on
 *   Linux we degrade to top-level only and document it).
 * - Debounced batching (100 ms window) — matches `DEBOUNCE_MS` in
 *   file_watcher.rs to keep callback ergonomics identical.
 * - Returns a `WatcherHandle`-shaped object usable with `stopWatcher()`.
 *
 * @param {string} dirPath - Absolute path to the directory to watch
 * @param {function(object[]): void} callback - Called with batched WatchEvent arrays
 * @returns {object} A handle object with `__fallback === true` and the
 *   internal fs watcher so `stopWatcher()` can shut it down.
 * @throws {Error} If `dirPath` does not exist.
 */
function watchDirectoryFallback(dirPath, callback) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`[styrby-native] watchDirectory: path does not exist: ${dirPath}`);
  }

  /** @type {Array<{kind: string, paths: string[]}>} */
  let pending = [];
  /** @type {NodeJS.Timeout|null} */
  let flushTimer = null;

  /**
   * WHY: Node's `fs.watch` event types are 'rename' (create/remove) and
   * 'change' (modify). We can rarely distinguish create from remove without
   * an extra fs.exists check, so we report 'create' on rename when the path
   * still exists and 'remove' otherwise. Best-effort; the native watcher
   * provides finer detail.
   */
  function classify(eventType, fullPath) {
    if (eventType === 'change') return 'modify';
    if (eventType === 'rename') {
      try {
        return fs.existsSync(fullPath) ? 'create' : 'remove';
      } catch {
        return 'other';
      }
    }
    return 'other';
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      try {
        callback(batch);
      } catch (err) {
        if (process.env.STYRBY_NATIVE_DEBUG) {
          process.stderr.write(`[styrby-native] watch callback threw: ${err.message}\n`);
        }
      }
    }, 100);
  }

  // Try recursive (works on darwin/win32). Fall back to non-recursive on Linux.
  let watcher;
  try {
    watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      const path = require('path');
      const full = filename ? path.join(dirPath, filename) : dirPath;
      pending.push({ kind: classify(eventType, full), paths: [full] });
      scheduleFlush();
    });
  } catch {
    watcher = fs.watch(dirPath, (eventType, filename) => {
      const path = require('path');
      const full = filename ? path.join(dirPath, filename) : dirPath;
      pending.push({ kind: classify(eventType, full), paths: [full] });
      scheduleFlush();
    });
  }

  return {
    __fallback: true,
    __watcher: watcher,
    __getFlushTimer: () => flushTimer,
    __stop: () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Module assembly
// ---------------------------------------------------------------------------

const nativeModule = tryLoadNative();

/**
 * Whether the native Rust module is loaded and active.
 *
 * @type {boolean}
 */
const isNativeLoaded = nativeModule !== null;

/**
 * Parsed version string of the loaded module.
 * `"js-fallback"` when native is not available.
 *
 * @type {string}
 */
const version = isNativeLoaded
  ? nativeModule.nativeVersion()
  : nativeVersionFallback();

/**
 * Parses a JSONL file and emits each TokenUsage record to a callback.
 *
 * Uses the native Rust implementation when available; falls back to the
 * readline-based JS implementation otherwise.
 *
 * **Note:** The native version is synchronous (blocks the calling thread for
 * I/O). The JS fallback is async. Always `await` this function.
 *
 * @param {string} filePath - Absolute path to the .jsonl file
 * @param {function(object): void} callback - Called for each TokenUsage record
 * @returns {Promise<void>|void} Promise when using JS fallback, void for native
 */
function parseJsonlFileStream(filePath, callback) {
  if (isNativeLoaded) {
    return nativeModule.parseJsonlFileStream(filePath, callback);
  }
  return parseJsonlFileStreamFallback(filePath, callback);
}

/**
 * Parses an entire JSONL file and returns all TokenUsage records as an array.
 *
 * Uses parallel Rayon processing in the native module for large files.
 * Falls back to the sequential readline parser when native is unavailable.
 *
 * @param {string} filePath - Absolute path to the .jsonl file
 * @returns {Promise<object[]>|object[]} Array of TokenUsage records
 */
function parseJsonlFileBatch(filePath) {
  if (isNativeLoaded) {
    return nativeModule.parseJsonlFileBatch(filePath);
  }
  return parseJsonlFileBatchFallback(filePath);
}

/**
 * Starts watching a directory for file system changes.
 *
 * Requires the native Rust module — the JS fallback always throws.
 *
 * @param {string} dirPath - Absolute path to the directory to watch
 * @param {function(object[]): void} callback - Called with batched WatchEvent arrays
 * @returns {object} WatcherHandle — pass to stopWatcher() to clean up
 * @throws {Error} If the native module is not loaded
 */
function watchDirectory(dirPath, callback) {
  if (isNativeLoaded) {
    return nativeModule.watchDirectory(dirPath, callback);
  }
  return watchDirectoryFallback(dirPath, callback);
}

/**
 * Stops a running file watcher and releases OS resources.
 *
 * @param {object} handle - WatcherHandle returned by watchDirectory()
 * @returns {void}
 * @throws {Error} If the native module is not loaded
 */
function stopWatcher(handle) {
  // WHY (Phase 0.4): Route to the JS fallback's internal __stop() when the
  // handle was issued by watchDirectoryFallback. Otherwise the native module
  // owns the handle and knows how to release the OS subscription.
  if (handle && handle.__fallback === true) {
    handle.__stop();
    return;
  }
  if (!isNativeLoaded) {
    throw new Error('[styrby-native] stopWatcher requires the native Rust module.');
  }
  return nativeModule.stopWatcher(handle);
}

module.exports = {
  isNativeLoaded,
  version,
  parseJsonlFileStream,
  parseJsonlFileBatch,
  watchDirectory,
  stopWatcher,
};
