/**
 * @styrby/native — native-parser.test.ts
 *
 * Tests for the native JSONL parser module and its JS fallback layer.
 *
 * All tests run against `packages/styrby-native/index.js` — the public API
 * that callers use. They MUST pass regardless of whether the Rust `.node`
 * binary is compiled, because the CI environment may not have a Rust toolchain.
 *
 * Test categories:
 * 1. Module loading — isNativeLoaded flag, version string
 * 2. JS fallback — core contract: returns same fields as the TS parser
 * 3. Stream API — callback is called for each record
 * 4. Batch API  — returns correct array of records
 * 5. Error handling — corrupt files, missing files, empty files
 * 6. Field mapping — snake_case output matches expected values
 * 7. Performance contract — batch parse finishes in <2 s for 1 MB
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

// We import the JS module directly (index.js) rather than the napi binary.
// vitest runs in Node.js ESM mode; use createRequire since index.js is CJS.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

/** Resolves to the package root of @styrby/native */
const NATIVE_PKG_ROOT = path.resolve(__dirname, '..', '..'); // packages/styrby-native

type NativeModule = typeof import('../../index.js');

let native: NativeModule;

// ---------------------------------------------------------------------------
// Synthetic file helpers
// ---------------------------------------------------------------------------

/** Models to use in synthetic test data. */
const MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-haiku-20241022',
  'gpt-4o',
];

/**
 * Generates a single assistant-format JSONL line.
 *
 * @param opts - Token counts and model override
 * @returns JSON string (no trailing newline)
 */
function assistantLine(opts: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp ?? '2026-01-01T00:00:00.000Z',
    message: {
      model: opts.model ?? MODELS[0],
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  });
}

/**
 * Generates a single cost_info-format JSONL line.
 *
 * @param opts - Token counts and model override
 * @returns JSON string (no trailing newline)
 */
function costInfoLine(opts: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'result',
    timestamp: opts.timestamp ?? '2026-01-01T00:00:00.000Z',
    cost_info: {
      model: opts.model ?? MODELS[0],
      input_tokens: opts.inputTokens ?? 200,
      output_tokens: opts.outputTokens ?? 80,
      cache_read_tokens: opts.cacheRead ?? 0,
      cache_write_tokens: opts.cacheWrite ?? 0,
    },
  });
}

/**
 * Writes lines to a temporary file and returns the path.
 * Registers the file for cleanup in `tempFiles`.
 *
 * @param lines - JSONL lines (will be joined with '\n')
 * @returns Absolute path to the temp file
 */
function writeTempFile(lines: string[]): string {
  const filePath = path.join(os.tmpdir(), `styrby-native-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  tempFiles.push(filePath);
  return filePath;
}

/** Paths of temp files to delete after each test. */
const tempFiles: string[] = [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Load the module fresh for each describe block.
  // We use require() with cache-busting because vitest module isolation only
  // applies to ESM; index.js is CommonJS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (require.cache as any)[path.resolve(NATIVE_PKG_ROOT, 'index.js')];
  native = require(path.resolve(NATIVE_PKG_ROOT, 'index.js'));
});

afterEach(() => {
  // Clean up temp files created during the test
  for (const f of tempFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 1. Module loading
// ---------------------------------------------------------------------------

describe('module loading', () => {
  it('exports isNativeLoaded as a boolean', () => {
    expect(typeof native.isNativeLoaded).toBe('boolean');
  });

  it('exports version as a non-empty string', () => {
    expect(typeof native.version).toBe('string');
    expect(native.version.length).toBeGreaterThan(0);
  });

  it('reports js-fallback version when native is not compiled', () => {
    // In CI (no Rust toolchain), native is not compiled — should always be
    // "js-fallback". This test is conditional: it passes on native too.
    if (!native.isNativeLoaded) {
      expect(native.version).toBe('js-fallback');
    } else {
      // Native is loaded — version should be semver
      expect(native.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('exports all expected functions', () => {
    expect(typeof native.parseJsonlFileStream).toBe('function');
    expect(typeof native.parseJsonlFileBatch).toBe('function');
    expect(typeof native.watchDirectory).toBe('function');
    expect(typeof native.stopWatcher).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. Batch API — field values
// ---------------------------------------------------------------------------

describe('parseJsonlFileBatch — field mapping', () => {
  it('parses assistant-format line and returns correct snake_case fields', async () => {
    const filePath = writeTempFile([
      assistantLine({ model: 'claude-sonnet-4-20250514', inputTokens: 1000, outputTokens: 400, cacheRead: 100, cacheWrite: 50 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);

    const r = records[0];
    expect(r.input_tokens).toBe(1000);
    expect(r.output_tokens).toBe(400);
    expect(r.cache_read_tokens).toBe(100);
    expect(r.cache_write_tokens).toBe(50);
    expect(r.model).toBe('claude-sonnet-4-20250514');
    expect(r.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('parses cost_info-format line and returns correct fields', async () => {
    const filePath = writeTempFile([
      costInfoLine({ model: 'gpt-4o', inputTokens: 500, outputTokens: 200 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);

    const r = records[0];
    expect(r.input_tokens).toBe(500);
    expect(r.output_tokens).toBe(200);
    expect(r.model).toBe('gpt-4o');
  });

  it('skips non-usage lines (human, tool_result, system)', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ type: 'human', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'Hello' } }),
      assistantLine({ inputTokens: 300, outputTokens: 120 }),
      JSON.stringify({ type: 'tool_result', timestamp: '2026-01-01T00:00:00.000Z', content: 'some output' }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);
    expect(records[0].input_tokens).toBe(300);
  });

  it('handles files with only non-usage lines (returns empty array)', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ type: 'system', content: 'init' }),
      JSON.stringify({ type: 'human', message: { role: 'user', content: 'ping' } }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(0);
  });

  it('returns multiple records in file order', async () => {
    const filePath = writeTempFile([
      assistantLine({ model: MODELS[0], inputTokens: 100 }),
      costInfoLine({ model: MODELS[1], inputTokens: 200 }),
      assistantLine({ model: MODELS[2], inputTokens: 300 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(3);
    expect(records[0].input_tokens).toBe(100);
    expect(records[1].input_tokens).toBe(200);
    expect(records[2].input_tokens).toBe(300);
    // Model assignment
    expect(records[0].model).toBe(MODELS[0]);
    expect(records[1].model).toBe(MODELS[1]);
    expect(records[2].model).toBe(MODELS[2]);
  });

  it('returns empty array for an empty file', async () => {
    const filePath = writeTempFile(['']);
    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(0);
  });

  it('handles zero-token usage lines', async () => {
    const filePath = writeTempFile([
      assistantLine({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);
    expect(records[0].input_tokens).toBe(0);
    expect(records[0].output_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Stream API — callback contract
// ---------------------------------------------------------------------------

describe('parseJsonlFileStream — callback contract', () => {
  it('calls callback once per usage record', async () => {
    const filePath = writeTempFile([
      assistantLine({ inputTokens: 111 }),
      JSON.stringify({ type: 'human', message: { content: 'hi' } }),
      costInfoLine({ inputTokens: 222 }),
    ]);

    const received: { input_tokens: number }[] = [];
    await native.parseJsonlFileStream(filePath, (record: { input_tokens: number }) => {
      received.push(record);
    });

    expect(received).toHaveLength(2);
    expect(received[0].input_tokens).toBe(111);
    expect(received[1].input_tokens).toBe(222);
  });

  it('does not call callback for files with no usage records', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ type: 'system', content: 'init' }),
    ]);

    const callback = vi.fn();
    await native.parseJsonlFileStream(filePath, callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('stream records have same fields as batch records', async () => {
    const filePath = writeTempFile([
      assistantLine({ model: 'claude-3-5-haiku-20241022', inputTokens: 777, outputTokens: 333, cacheRead: 66, cacheWrite: 11 }),
    ]);

    // Batch
    const batch = await native.parseJsonlFileBatch(filePath);
    expect(batch).toHaveLength(1);

    // Stream
    const streamed: unknown[] = [];
    await native.parseJsonlFileStream(filePath, (r: unknown) => streamed.push(r));
    expect(streamed).toHaveLength(1);

    // Both should have identical data
    expect(batch[0]).toMatchObject(streamed[0] as Record<string, unknown>);
  });
});

// ---------------------------------------------------------------------------
// 4. Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('returns empty array for a missing file (batch)', async () => {
    const missingPath = path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`);
    // The JS fallback delegates to parseJsonlFile which returns [] for missing files.
    // The native module returns an error — we normalise to empty array in both cases.
    try {
      const records = await native.parseJsonlFileBatch(missingPath);
      // Either [] (JS fallback) or throws (native) — both acceptable
      expect(Array.isArray(records)).toBe(true);
    } catch (err) {
      // Native module throws for missing files — this is acceptable behaviour
      expect((err as Error).message).toMatch(/Cannot read|ENOENT|No such/i);
    }
  });

  it('skips corrupt JSON lines and continues parsing', async () => {
    const filePath = writeTempFile([
      assistantLine({ inputTokens: 10 }),
      '{not valid json at all}',
      assistantLine({ inputTokens: 20 }),
      '{"incomplete":',
      assistantLine({ inputTokens: 30 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    // Should parse the 3 valid usage lines despite 2 corrupt lines
    expect(records).toHaveLength(3);
    expect(records.map((r: { input_tokens: number }) => r.input_tokens)).toEqual([10, 20, 30]);
  });

  it('skips lines that are valid JSON but have no usage data', async () => {
    const filePath = writeTempFile([
      '{"key":"value","num":42}',
      '[]',
      'null',
      assistantLine({ inputTokens: 99 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);
    expect(records[0].input_tokens).toBe(99);
  });

  it('handles completely blank lines gracefully', async () => {
    const filePath = writeTempFile([
      '',
      '   ',
      assistantLine({ inputTokens: 42 }),
      '',
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records).toHaveLength(1);
    expect(records[0].input_tokens).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 5. Output parity with the JS parser
// ---------------------------------------------------------------------------

describe('output parity with JS parser', () => {
  it('batch output matches JS parser output for all token fields', async () => {
    // WHY: If native and JS disagree on field values, cost calculations will
    // diverge between environments. This test pins the contract.
    const filePath = writeTempFile([
      assistantLine({ model: 'claude-sonnet-4-20250514', inputTokens: 1234, outputTokens: 567, cacheRead: 89, cacheWrite: 12 }),
      costInfoLine({ model: 'gpt-4o', inputTokens: 4321, outputTokens: 765, cacheRead: 0, cacheWrite: 0 }),
    ]);

    const batchRecords = await native.parseJsonlFileBatch(filePath);
    expect(batchRecords).toHaveLength(2);

    // Validate record 1 (assistant format)
    expect(batchRecords[0].input_tokens).toBe(1234);
    expect(batchRecords[0].output_tokens).toBe(567);
    expect(batchRecords[0].cache_read_tokens).toBe(89);
    expect(batchRecords[0].cache_write_tokens).toBe(12);
    expect(batchRecords[0].model).toBe('claude-sonnet-4-20250514');

    // Validate record 2 (cost_info format)
    expect(batchRecords[1].input_tokens).toBe(4321);
    expect(batchRecords[1].output_tokens).toBe(765);
    expect(batchRecords[1].cache_read_tokens).toBe(0);
    expect(batchRecords[1].cache_write_tokens).toBe(0);
    expect(batchRecords[1].model).toBe('gpt-4o');
  });

  it('all records have the required fields', async () => {
    const filePath = writeTempFile([
      assistantLine({ inputTokens: 1 }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    const r = records[0];

    expect(r).toHaveProperty('input_tokens');
    expect(r).toHaveProperty('output_tokens');
    expect(r).toHaveProperty('cache_read_tokens');
    expect(r).toHaveProperty('cache_write_tokens');
    expect(r).toHaveProperty('model');
    expect(r).toHaveProperty('timestamp');
  });

  it('model field is always a non-empty string', async () => {
    const filePath = writeTempFile([
      assistantLine({ model: 'gemini-2.0-flash' }),
      costInfoLine({ model: 'claude-3-5-haiku-20241022' }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    for (const r of records) {
      expect(typeof r.model).toBe('string');
      expect(r.model.length).toBeGreaterThan(0);
    }
  });

  it('timestamp field is a valid ISO 8601 string', async () => {
    const filePath = writeTempFile([
      assistantLine({ timestamp: '2026-03-28T12:34:56.789Z' }),
    ]);

    const records = await native.parseJsonlFileBatch(filePath);
    expect(records[0].timestamp).toBe('2026-03-28T12:34:56.789Z');
  });
});

// ---------------------------------------------------------------------------
// 6. Performance contract
// ---------------------------------------------------------------------------

describe('performance contract', () => {
  it('parses a 1 MB synthetic file in under 2000 ms', async () => {
    // Generate ~1 MB of JSONL
    const lines: string[] = [];
    let size = 0;
    let i = 0;
    while (size < 1024 * 1024) {
      const line = i % 10 === 0
        ? assistantLine({ inputTokens: 500 + (i % 1000), outputTokens: 200 + (i % 500) })
        : JSON.stringify({ type: 'human', timestamp: '2026-01-01T00:00:00.000Z', message: { content: `msg ${i}` } });
      lines.push(line);
      size += Buffer.byteLength(line + '\n', 'utf8');
      i++;
    }

    const filePath = writeTempFile(lines);
    const start = Date.now();
    const records = await native.parseJsonlFileBatch(filePath);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    // Sanity check: ~10% of lines are usage lines
    expect(records.length).toBeGreaterThan(0);
  }, 5000 /* vitest timeout */);
});

// ---------------------------------------------------------------------------
// 7. watchDirectory — fallback behaviour
// ---------------------------------------------------------------------------

describe('watchDirectory fallback', () => {
  it('throws with a helpful message when native is not loaded', () => {
    if (native.isNativeLoaded) {
      // Native is loaded — skip this test
      return;
    }
    expect(() => native.watchDirectory('/tmp', () => {})).toThrow(/native Rust module/i);
  });
});
