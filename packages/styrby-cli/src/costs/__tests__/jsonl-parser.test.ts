/**
 * Unit tests for `jsonl-parser.ts`.
 *
 * Covers the synchronous helpers (`calculateCost`, `calculateInputCost`,
 * `getAgentTypeForModel`) and the pure-JS JSONL file parser
 * (`parseJsonlFile`). File-system-dependent tests use `tmp` directories
 * created via Node's `fs.mkdtempSync` so they never pollute `~/.claude`.
 *
 * WHY: These parsers are on the hot path — every session cost displayed in
 * the app flows through them. Regressions here silently mis-bill users.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================================
// Mock @styrby/shared/pricing
// WHY: litellm-pricing uses Node.js builtins (node:path, node:os, node:fs,
// node:crypto) that are not available in the Vitest environment. We return
// static Sonnet-4 pricing for deterministic math in tests.
// ============================================================================

vi.mock('@styrby/shared/pricing', () => ({
  getModelPriceSync: vi.fn(() => ({
    inputPer1k: 0.003,     // $3.00 / 1M
    outputPer1k: 0.015,    // $15.00 / 1M
    cachePer1k: 0.0003,    // $0.30 / 1M
    cacheWritePer1k: 0.00375, // $3.75 / 1M
  })),
  getModelPrice: vi.fn(async () => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
}));

import {
  calculateCost,
  calculateInputCost,
  getAgentTypeForModel,
  parseJsonlFile,
  aggregateCosts,
  getCostsForDateRange,
  type TokenUsage,
} from '../jsonl-parser.js';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Builds a minimal TokenUsage fixture, allowing field overrides.
 */
function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: 'claude-sonnet-4-20250514',
    timestamp: new Date('2026-03-01T12:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// getAgentTypeForModel
// ============================================================================

describe('getAgentTypeForModel', () => {
  it('maps claude- prefix to "claude"', () => {
    expect(getAgentTypeForModel('claude-sonnet-4-20250514')).toBe('claude');
    expect(getAgentTypeForModel('claude-opus-4-5-20251101')).toBe('claude');
    expect(getAgentTypeForModel('claude-3-5-haiku-20241022')).toBe('claude');
  });

  it('maps gpt- prefix to "codex"', () => {
    expect(getAgentTypeForModel('gpt-4o')).toBe('codex');
    expect(getAgentTypeForModel('gpt-4o-mini')).toBe('codex');
    expect(getAgentTypeForModel('gpt-4-turbo')).toBe('codex');
  });

  it('maps o1- prefix to "codex"', () => {
    expect(getAgentTypeForModel('o1-preview')).toBe('codex');
    expect(getAgentTypeForModel('o1-mini')).toBe('codex');
  });

  it('maps o3- prefix to "codex"', () => {
    expect(getAgentTypeForModel('o3-mini')).toBe('codex');
  });

  it('maps gemini- prefix to "gemini"', () => {
    expect(getAgentTypeForModel('gemini-2.0-flash')).toBe('gemini');
    expect(getAgentTypeForModel('gemini-1.5-pro')).toBe('gemini');
  });

  it('returns null for unknown model names', () => {
    expect(getAgentTypeForModel('unknown-model-xyz')).toBeNull();
    expect(getAgentTypeForModel('')).toBeNull();
    expect(getAgentTypeForModel('llama-3')).toBeNull();
  });

  it('is case-insensitive (lowercases before matching)', () => {
    // WHY: Model names from different providers may arrive mixed-case.
    expect(getAgentTypeForModel('Claude-Sonnet-4')).toBe('claude');
    expect(getAgentTypeForModel('GPT-4o')).toBe('codex');
    expect(getAgentTypeForModel('Gemini-2.0-Flash')).toBe('gemini');
  });
});

// ============================================================================
// calculateCost
// ============================================================================

describe('calculateCost', () => {
  it('computes cost from input + output tokens only when no cache', () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // 1M input @ $3.00/1M = $3.00
    const cost = calculateCost(usage);
    expect(cost).toBeCloseTo(3.0, 4);
  });

  it('adds output cost component', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // 1M output @ $15.00/1M = $15.00
    expect(calculateCost(usage)).toBeCloseTo(15.0, 4);
  });

  it('adds cache-read cost when present', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    // 1M cache read @ $0.30/1M = $0.30
    expect(calculateCost(usage)).toBeCloseTo(0.30, 4);
  });

  it('adds cache-write cost when present', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 });
    // 1M cache write @ $3.75/1M = $3.75
    expect(calculateCost(usage)).toBeCloseTo(3.75, 4);
  });

  it('returns zero cost for all-zero token counts', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(calculateCost(usage)).toBe(0);
  });

  it('sums all four cost components correctly', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    // 3.00 + 15.00 + 0.30 + 3.75 = 22.05
    expect(calculateCost(usage)).toBeCloseTo(22.05, 4);
  });

  it('uses STYRBY_MODEL_PRICING_JSON env override when valid JSON', () => {
    const override = JSON.stringify({
      'test-model': { input: 100.0, output: 200.0 },
    });
    process.env.STYRBY_MODEL_PRICING_JSON = override;

    const usage = makeUsage({ model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const cost = calculateCost(usage);
    // 1M input @ $100.00/1M = $100.00
    expect(cost).toBeCloseTo(100.0, 4);

    delete process.env.STYRBY_MODEL_PRICING_JSON;
  });

  it('falls back to dynamic pricing when STYRBY_MODEL_PRICING_JSON is invalid JSON', () => {
    process.env.STYRBY_MODEL_PRICING_JSON = 'not-valid-json{{{';

    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Should not throw; falls through to getModelPriceSync mock ($3.00/1M)
    expect(() => calculateCost(usage)).not.toThrow();

    delete process.env.STYRBY_MODEL_PRICING_JSON;
  });
});

// ============================================================================
// calculateInputCost
// ============================================================================

describe('calculateInputCost', () => {
  it('returns only input + cache costs, not output costs', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000, // should NOT be included
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    // input ($3.00) + cacheRead ($0.30) = $3.30
    expect(calculateInputCost(usage)).toBeCloseTo(3.30, 4);
  });

  it('excludes output tokens entirely', () => {
    const withOutput = makeUsage({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(calculateInputCost(withOutput)).toBe(0);
  });

  it('includes cache-write cost', () => {
    const usage = makeUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    // 1M cache write @ $3.75/1M = $3.75
    expect(calculateInputCost(usage)).toBeCloseTo(3.75, 4);
  });

  it('returns zero for all-zero token usage', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(calculateInputCost(usage)).toBe(0);
  });
});

// ============================================================================
// parseJsonlFile — pure JS readline path
// ============================================================================

/** Temp directories created during tests — cleaned up in afterEach. */
const tmpDirs: string[] = [];

/**
 * Creates a temp directory and returns its path.
 * Registered for cleanup in afterEach.
 */
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-test-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Writes lines to a `.jsonl` temp file and returns the file path.
 *
 * @param lines - Array of raw strings (one per JSONL line).
 * @param dir - Optional temp directory to write into.
 */
function writeJsonlFile(lines: string[], dir?: string): string {
  const tmpDir = dir ?? makeTmpDir();
  const filePath = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

afterEach(() => {
  // Clean up all temp dirs created during this test
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — don't fail the test on cleanup errors
    }
  }
  tmpDirs.length = 0;
});

describe('parseJsonlFile', () => {
  it('returns empty array for a non-existent file', async () => {
    const result = await parseJsonlFile('/tmp/does-not-exist-styrby-test.jsonl');
    expect(result).toEqual([]);
  });

  it('parses a Claude Code assistant message with usage', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    });
    const file = writeJsonlFile([line]);
    const usages = await parseJsonlFile(file);
    expect(usages).toHaveLength(1);
    expect(usages[0].inputTokens).toBe(100);
    expect(usages[0].outputTokens).toBe(50);
    expect(usages[0].cacheReadTokens).toBe(20);
    expect(usages[0].cacheWriteTokens).toBe(5);
    expect(usages[0].model).toBe('claude-sonnet-4-20250514');
    expect(usages[0].timestamp).toBeInstanceOf(Date);
  });

  it('parses a cost_info format line', async () => {
    const line = JSON.stringify({
      cost_info: {
        model: 'gpt-4o',
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      timestamp: '2026-03-01T13:00:00.000Z',
    });
    const file = writeJsonlFile([line]);
    const usages = await parseJsonlFile(file);
    expect(usages).toHaveLength(1);
    expect(usages[0].inputTokens).toBe(200);
    expect(usages[0].model).toBe('gpt-4o');
  });

  it('skips non-assistant message lines silently', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: 'hello' }),
      JSON.stringify({ type: 'summary', text: 'session summary' }),
      JSON.stringify({ type: 'system', content: 'context' }),
    ];
    const file = writeJsonlFile(lines);
    const usages = await parseJsonlFile(file);
    expect(usages).toEqual([]);
  });

  it('skips malformed (non-JSON) lines without throwing', async () => {
    const lines = [
      'not json at all}}}',
      '',
      '{"broken":',
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-03-01T12:00:00.000Z',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ];
    const file = writeJsonlFile(lines);
    const usages = await parseJsonlFile(file);
    // Only the valid assistant line should parse
    expect(usages).toHaveLength(1);
    expect(usages[0].inputTokens).toBe(10);
  });

  it('skips blank lines silently', async () => {
    const lines = ['', '   ', '\t'];
    const file = writeJsonlFile(lines);
    const usages = await parseJsonlFile(file);
    expect(usages).toEqual([]);
  });

  it('handles missing usage fields by defaulting to 0', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: {
          // intentionally missing: output_tokens, cache fields
          input_tokens: 42,
        },
      },
    });
    const file = writeJsonlFile([line]);
    const usages = await parseJsonlFile(file);
    expect(usages[0].inputTokens).toBe(42);
    expect(usages[0].outputTokens).toBe(0);
    expect(usages[0].cacheReadTokens).toBe(0);
    expect(usages[0].cacheWriteTokens).toBe(0);
  });

  it('defaults model to "unknown" when absent', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1 } },
    });
    const file = writeJsonlFile([line]);
    const usages = await parseJsonlFile(file);
    expect(usages[0].model).toBe('unknown');
  });

  it('parses multiple valid lines from one file', async () => {
    const lines = [1, 2, 3].map((i) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: `2026-03-0${i}T12:00:00.000Z`,
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: i * 10, output_tokens: i * 5 } },
      }),
    );
    const file = writeJsonlFile(lines);
    const usages = await parseJsonlFile(file);
    expect(usages).toHaveLength(3);
    expect(usages[0].inputTokens).toBe(10);
    expect(usages[1].inputTokens).toBe(20);
    expect(usages[2].inputTokens).toBe(30);
  });
});

// ============================================================================
// aggregateCosts
// ============================================================================

describe('aggregateCosts', () => {
  it('returns a zeroed summary for an empty file list', async () => {
    const summary = await aggregateCosts([]);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.sessionCount).toBe(0);
    expect(summary.byModel).toEqual({});
  });

  it('aggregates tokens across multiple files', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00.000Z',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const dir = makeTmpDir();
    const file1 = path.join(dir, 'session1.jsonl');
    const file2 = path.join(dir, 'session2.jsonl');
    fs.writeFileSync(file1, line);
    fs.writeFileSync(file2, line);

    const summary = await aggregateCosts([file1, file2]);
    expect(summary.sessionCount).toBe(2);
    expect(summary.totalInputTokens).toBe(200);
    expect(summary.totalOutputTokens).toBe(100);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
  });

  it('tracks byModel breakdown', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00.000Z',
      message: { model: 'gpt-4o', usage: { input_tokens: 50, output_tokens: 25 } },
    });
    const file = writeJsonlFile([line]);
    const summary = await aggregateCosts([file]);
    expect(summary.byModel['gpt-4o']).toBeDefined();
    expect(summary.byModel['gpt-4o'].inputTokens).toBe(50);
  });

  it('sets firstTimestamp and lastTimestamp across entries', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-01T10:00:00.000Z', message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-01T12:00:00.000Z', message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 2, output_tokens: 0 } } }),
    ];
    const file = writeJsonlFile(lines);
    const summary = await aggregateCosts([file]);
    expect(summary.firstTimestamp).toBeDefined();
    expect(summary.lastTimestamp).toBeDefined();
    expect(summary.firstTimestamp!.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(summary.lastTimestamp!.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });
});

// ============================================================================
// getCostsForDateRange
// ============================================================================

describe('getCostsForDateRange', () => {
  it('returns zeroed summary when no files are in range', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-02T00:00:00Z');
    const summary = await getCostsForDateRange(start, end, []);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.sessionCount).toBe(0);
  });

  it('includes entries within the date range', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-15T12:00:00.000Z',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const file = writeJsonlFile([line]);
    const start = new Date('2026-03-15T00:00:00Z');
    const end = new Date('2026-03-16T00:00:00Z');
    const summary = await getCostsForDateRange(start, end, [file]);
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.sessionCount).toBe(1);
  });

  it('excludes entries outside the date range', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-02-01T12:00:00.000Z',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const file = writeJsonlFile([line]);
    const start = new Date('2026-03-15T00:00:00Z');
    const end = new Date('2026-03-16T00:00:00Z');
    const summary = await getCostsForDateRange(start, end, [file]);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.sessionCount).toBe(0);
  });

  it('filters by agentType when provided', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-15T12:00:00.000Z', message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-15T12:01:00.000Z', message: { model: 'gpt-4o', usage: { input_tokens: 200, output_tokens: 100 } } }),
    ];
    const file = writeJsonlFile(lines);
    const start = new Date('2026-03-15T00:00:00Z');
    const end = new Date('2026-03-16T00:00:00Z');

    // Filter to claude only
    const summary = await getCostsForDateRange(start, end, [file], 'claude');
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.byModel['claude-sonnet-4-20250514']).toBeDefined();
    expect(summary.byModel['gpt-4o']).toBeUndefined();
  });

  it('does not increment sessionCount for a file with no in-range entries', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-01T12:00:00.000Z',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const file = writeJsonlFile([line]);
    const start = new Date('2026-03-15T00:00:00Z');
    const end = new Date('2026-03-16T00:00:00Z');
    const summary = await getCostsForDateRange(start, end, [file]);
    expect(summary.sessionCount).toBe(0);
  });
});
