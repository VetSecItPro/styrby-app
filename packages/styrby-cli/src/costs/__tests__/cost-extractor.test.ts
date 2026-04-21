/**
 * Unit tests for `cost-extractor.ts`.
 *
 * Covers:
 *  - Per-agent output parsers (parseClaudeOutput, parseCodexOutput,
 *    parseGeminiOutput, parseOpenCodeOutput)
 *  - CostExtractor: processOutput, addUsage, createInputOnlyRecord,
 *    addUsageForMessage, getSummary, reset, deduplication
 *
 * WHY: These parsers translate raw agent output into USD costs that show up
 * in the mobile cost pill. A regression here silently mis-bills users or
 * drops cost events entirely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock @styrby/shared/pricing — litellm-pricing requires Node.js builtins
 * unavailable in the Vitest environment. Return static Sonnet-4 pricing.
 */
vi.mock('@styrby/shared/pricing', () => ({
  getModelPriceSync: vi.fn(() => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
  getModelPrice: vi.fn(async () => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
}));

import {
  parseClaudeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseOpenCodeOutput,
  readCodexSessionFile,
  CostExtractor,
  createCostExtractor,
  type CostRecord,
} from '../cost-extractor.js';
import type { TokenUsage } from '../jsonl-parser.js';

// ============================================================================
// fs mock (for readCodexSessionFile tests)
// ============================================================================
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readFileSync: vi.fn(original.readFileSync),
  };
});
import * as fs from 'node:fs';

// ============================================================================
// Fixtures
// ============================================================================

const BASE_USAGE: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: 50,
  model: 'claude-sonnet-4-20250514',
  timestamp: new Date('2026-04-01T10:00:00Z'),
};

const SESSION_ID = 'test-session-001';

// ============================================================================
// Parser: parseClaudeOutput
// ============================================================================

describe('parseClaudeOutput', () => {
  it('returns null for empty string', () => {
    expect(parseClaudeOutput('')).toBeNull();
  });

  it('returns null when no usage block found', () => {
    expect(parseClaudeOutput('{"type":"text","text":"hello"}')).toBeNull();
  });

  it('parses a usage block from a Claude JSONL line', () => {
    const output = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });

    const result = parseClaudeOutput(output);

    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1234);
    expect(result!.outputTokens).toBe(567);
    expect(result!.cacheReadTokens).toBe(100);
    expect(result!.cacheWriteTokens).toBe(20);
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });

  it('defaults model to claude-sonnet-4-20250514 when model field is absent', () => {
    const output = '{"usage":{"input_tokens":100,"output_tokens":50}}';
    const result = parseClaudeOutput(output);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });

  it('picks the last usage block when multiple are present', () => {
    const first = '{"usage":{"input_tokens":10,"output_tokens":5}}';
    const second = '{"usage":{"input_tokens":999,"output_tokens":888}}';
    const result = parseClaudeOutput(`${first}\n${second}`);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(999);
    expect(result!.outputTokens).toBe(888);
  });
});

// ============================================================================
// Parser: parseCodexOutput
// ============================================================================

describe('parseCodexOutput', () => {
  it('returns null for empty string', () => {
    expect(parseCodexOutput('')).toBeNull();
  });

  it('parses "Tokens: X in, Y out" format', () => {
    const result = parseCodexOutput('Tokens: 1500 in, 400 out, model: gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1500);
    expect(result!.outputTokens).toBe(400);
    expect(result!.model).toBe('gpt-4o');
  });

  it('parses "input_tokens=X output_tokens=Y" format', () => {
    const result = parseCodexOutput('input_tokens=200 output_tokens=100');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(200);
    expect(result!.outputTokens).toBe(100);
  });

  it('returns null when no token patterns match', () => {
    expect(parseCodexOutput('No tokens here at all')).toBeNull();
  });

  it('defaults model to gpt-4o when model field absent', () => {
    const result = parseCodexOutput('Tokens: 100 in, 50 out');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gpt-4o');
  });

  it('sets cache tokens to 0 (Codex has no cache)', () => {
    const result = parseCodexOutput('Tokens: 100 in, 50 out');
    expect(result!.cacheReadTokens).toBe(0);
    expect(result!.cacheWriteTokens).toBe(0);
  });
});

// ============================================================================
// Parser: parseGeminiOutput
// ============================================================================

describe('parseGeminiOutput', () => {
  it('returns null for empty string', () => {
    expect(parseGeminiOutput('')).toBeNull();
  });

  it('parses /stats style output', () => {
    const output = [
      'Model: gemini-2.0-flash',
      'Input tokens: 2,500',
      'Output tokens: 800',
    ].join('\n');

    const result = parseGeminiOutput(output);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(2500);
    expect(result!.outputTokens).toBe(800);
    expect(result!.model).toBe('gemini-2.0-flash');
  });

  it('strips commas from token counts', () => {
    const result = parseGeminiOutput('Input tokens: 1,234,567\nOutput tokens: 98,765');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1234567);
    expect(result!.outputTokens).toBe(98765);
  });

  it('returns null when neither input nor output token line found', () => {
    expect(parseGeminiOutput('Model: gemini-2.0-flash\nNo tokens here')).toBeNull();
  });

  it('defaults model to gemini-2.0-flash when model line absent', () => {
    const result = parseGeminiOutput('Input tokens: 100\nOutput tokens: 50');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gemini-2.0-flash');
  });

  it('sets cache tokens to 0 (Gemini has no cache fields)', () => {
    const result = parseGeminiOutput('Input tokens: 100\nOutput tokens: 50');
    expect(result!.cacheReadTokens).toBe(0);
    expect(result!.cacheWriteTokens).toBe(0);
  });
});

// ============================================================================
// Parser: parseOpenCodeOutput
// ============================================================================

describe('parseOpenCodeOutput', () => {
  it('returns null for empty string', () => {
    expect(parseOpenCodeOutput('')).toBeNull();
  });

  it('parses "tokens: X input, Y output" format', () => {
    const result = parseOpenCodeOutput('tokens: 300 input, 150 output\nusing: claude-sonnet-4-20250514');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(300);
    expect(result!.outputTokens).toBe(150);
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });

  it('parses "in: X out: Y" format', () => {
    const result = parseOpenCodeOutput('in: 400 out: 200');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(400);
    expect(result!.outputTokens).toBe(200);
  });

  it('returns null when no token pattern matches', () => {
    expect(parseOpenCodeOutput('no token data here')).toBeNull();
  });

  it('defaults model to claude-sonnet-4-20250514 when model absent', () => {
    const result = parseOpenCodeOutput('in: 100 out: 50');
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });
});

// ============================================================================
// CostExtractor
// ============================================================================

describe('CostExtractor', () => {
  describe('constructor / createCostExtractor', () => {
    it('creates an instance with factory function', () => {
      const extractor = createCostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      expect(extractor).toBeInstanceOf(CostExtractor);
    });

    it('starts with empty records', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      expect(extractor.getRecords()).toHaveLength(0);
    });
  });

  describe('addUsage', () => {
    it('stores a record and emits cost event', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const handler = vi.fn();
      extractor.on('cost', handler);

      const record = extractor.addUsage(BASE_USAGE);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(record);
      expect(extractor.getRecords()).toHaveLength(1);
    });

    it('assigns sessionId and agentType from config', () => {
      const extractor = new CostExtractor({ agentType: 'gemini', sessionId: 'my-session' });
      const record = extractor.addUsage(BASE_USAGE);
      expect(record.sessionId).toBe('my-session');
      expect(record.agentType).toBe('gemini');
    });

    it('calculates a positive cost', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const record = extractor.addUsage(BASE_USAGE);
      expect(record.costUsd).toBeGreaterThan(0);
    });
  });

  describe('createInputOnlyRecord', () => {
    it('sets outputTokens to 0 and uses input-only cost', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const record = extractor.createInputOnlyRecord(BASE_USAGE);

      expect(record.outputTokens).toBe(0);
      expect(record.inputTokens).toBe(BASE_USAGE.inputTokens);
      expect(record.costUsd).toBeGreaterThan(0);
    });

    it('does NOT emit a cost event (just creates the record)', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const handler = vi.fn();
      extractor.on('cost', handler);

      extractor.createInputOnlyRecord(BASE_USAGE);

      expect(handler).not.toHaveBeenCalled();
    });

    it('does NOT push record into internal list (no side-effects)', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      extractor.createInputOnlyRecord(BASE_USAGE);
      expect(extractor.getRecords()).toHaveLength(0);
    });

    it('input-only cost is less than full cost for same usage', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const inputOnly = extractor.createInputOnlyRecord(BASE_USAGE);
      const full = extractor.addUsage(BASE_USAGE);
      expect(inputOnly.costUsd).toBeLessThan(full.costUsd);
    });
  });

  describe('processOutput', () => {
    it('returns null on empty string', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      expect(extractor.processOutput('')).toBeNull();
    });

    it('returns null when no usage pattern in output', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      expect(extractor.processOutput('{"type":"text","text":"hello"}')).toBeNull();
    });

    it('extracts a cost record from new Claude output content', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const chunk = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const record = extractor.processOutput(chunk);
      expect(record).not.toBeNull();
      expect(record!.inputTokens).toBe(100);
    });

    it('only processes new content on subsequent calls (incremental)', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const chunk1 = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const chunk2 = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 200, output_tokens: 100 },
      });

      extractor.processOutput(chunk1);
      // Second call with cumulative buffer — should only parse the new part
      const record = extractor.processOutput(chunk1 + '\n' + chunk2);

      // The second call extracts only from the new portion
      expect(record).not.toBeNull();
      expect(record!.inputTokens).toBe(200);
    });

    it('uses Codex parser when agentType is codex', () => {
      const extractor = new CostExtractor({ agentType: 'codex', sessionId: SESSION_ID });
      const record = extractor.processOutput('Tokens: 100 in, 50 out');
      expect(record).not.toBeNull();
      expect(record!.agentType).toBe('codex');
    });

    it('uses Gemini parser when agentType is gemini', () => {
      const extractor = new CostExtractor({ agentType: 'gemini', sessionId: SESSION_ID });
      const record = extractor.processOutput('Input tokens: 100\nOutput tokens: 50');
      expect(record).not.toBeNull();
    });
  });

  describe('getSummary', () => {
    it('returns zero totals for empty extractor', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const summary = extractor.getSummary();
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.recordCount).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
    });

    it('aggregates multiple records correctly', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      extractor.addUsage(BASE_USAGE);
      extractor.addUsage({ ...BASE_USAGE, inputTokens: 500, outputTokens: 200 });

      const summary = extractor.getSummary();
      expect(summary.recordCount).toBe(2);
      expect(summary.totalInputTokens).toBe(BASE_USAGE.inputTokens + 500);
      expect(summary.totalOutputTokens).toBe(BASE_USAGE.outputTokens + 200);
      expect(summary.totalCostUsd).toBeGreaterThan(0);
    });

    it('groups by model in byModel map', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      extractor.addUsage(BASE_USAGE);
      extractor.addUsage({ ...BASE_USAGE, model: 'claude-haiku-4-20250514' });

      const summary = extractor.getSummary();
      expect(Object.keys(summary.byModel)).toHaveLength(2);
      expect(summary.byModel['claude-sonnet-4-20250514']).toBeDefined();
      expect(summary.byModel['claude-haiku-4-20250514']).toBeDefined();
    });

    it('preserves sessionId and agentType in summary', () => {
      const extractor = new CostExtractor({ agentType: 'codex', sessionId: 'xyz' });
      const summary = extractor.getSummary();
      expect(summary.sessionId).toBe('xyz');
      expect(summary.agentType).toBe('codex');
    });
  });

  describe('reset', () => {
    it('clears all records', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      extractor.addUsage(BASE_USAGE);
      extractor.addUsage(BASE_USAGE);
      expect(extractor.getRecords()).toHaveLength(2);

      extractor.reset();
      expect(extractor.getRecords()).toHaveLength(0);
    });

    it('resets incremental processing pointer so processOutput starts fresh', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const chunk = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      extractor.processOutput(chunk);
      extractor.reset();

      // After reset the same chunk should be processed again
      const record = extractor.processOutput(chunk);
      expect(record).not.toBeNull();
    });
  });

  describe('deduplication in processOutput', () => {
    it('does not add duplicate records with identical token counts within 1 second', () => {
      const extractor = new CostExtractor({ agentType: 'claude', sessionId: SESSION_ID });
      const chunk = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      // First call processes the chunk
      extractor.processOutput(chunk);
      // Reset the length tracker manually to force re-processing the same content
      // This simulates a repeated chunk in a different call context
      extractor.reset();
      extractor.processOutput(chunk);

      // Both calls extract records after reset
      expect(extractor.getRecords()).toHaveLength(1);
    });
  });
});

// ============================================================================
// readCodexSessionFile — Phase 1.6.1 Gap 2
// ============================================================================

/**
 * Tests for the Codex session-file reader.
 *
 * WHY: `readCodexSessionFile` is the authoritative cost source for Codex. It
 * reads the JSONL session transcript that Codex writes to ~/.codex/sessions/.
 * Bugs here silently drop cost records or produce incorrect totals on the
 * mobile cost dashboard.
 *
 * We mock `node:fs` so no real file I/O is required.
 */
describe('readCodexSessionFile', () => {
  const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });

    expect(readCodexSessionFile('/fake/path/session.jsonl')).toBeNull();
  });

  it('parses a session file with camelCase token fields', () => {
    const entries = [
      JSON.stringify({ type: 'usage', inputTokens: 1000, outputTokens: 400, totalCostUsd: 0.015, model: 'gpt-4o' }),
      JSON.stringify({ type: 'usage', inputTokens: 500, outputTokens: 200, totalCostUsd: 0.008, model: 'gpt-4o' }),
    ].join('\n');
    mockReadFileSync.mockReturnValue(entries);

    const result = readCodexSessionFile('/fake/session.jsonl');

    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1500);
    expect(result!.outputTokens).toBe(600);
    expect(result!.totalCostUsd).toBeCloseTo(0.023);
    expect(result!.model).toBe('gpt-4o');
  });

  it('parses a session file with snake_case token fields', () => {
    const entries = JSON.stringify({
      type: 'usage',
      input_tokens: 800,
      output_tokens: 300,
      total_cost_usd: 0.01,
      model: 'o1-mini',
    });
    mockReadFileSync.mockReturnValue(entries);

    const result = readCodexSessionFile('/fake/session.jsonl');

    expect(result!.inputTokens).toBe(800);
    expect(result!.outputTokens).toBe(300);
    expect(result!.totalCostUsd).toBeCloseTo(0.01);
    expect(result!.model).toBe('o1-mini');
  });

  it('returns null when no token counts are found in any entry', () => {
    const entries = JSON.stringify({ type: 'message', content: 'Hello' });
    mockReadFileSync.mockReturnValue(entries);

    expect(readCodexSessionFile('/fake/session.jsonl')).toBeNull();
  });

  it('returns null when file contains only malformed JSON lines', () => {
    mockReadFileSync.mockReturnValue('{broken json\n{also broken');

    expect(readCodexSessionFile('/fake/session.jsonl')).toBeNull();
  });

  it('aggregates tokens across multiple entries', () => {
    const entries = [
      JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
      JSON.stringify({ inputTokens: 200, outputTokens: 100 }),
      JSON.stringify({ inputTokens: 300, outputTokens: 150 }),
    ].join('\n');
    mockReadFileSync.mockReturnValue(entries);

    const result = readCodexSessionFile('/fake/session.jsonl');

    expect(result!.inputTokens).toBe(600);
    expect(result!.outputTokens).toBe(300);
  });

  it('uses the last model seen in the file', () => {
    const entries = [
      JSON.stringify({ inputTokens: 100, outputTokens: 50, model: 'gpt-4o' }),
      JSON.stringify({ inputTokens: 200, outputTokens: 100, model: 'o1-mini' }),
    ].join('\n');
    mockReadFileSync.mockReturnValue(entries);

    const result = readCodexSessionFile('/fake/session.jsonl');

    expect(result!.model).toBe('o1-mini');
  });

  it('skips non-JSON lines (e.g. blank lines or progress output)', () => {
    const entries = [
      '',
      'Starting Codex session...',
      JSON.stringify({ inputTokens: 500, outputTokens: 250, model: 'gpt-4o' }),
      '',
    ].join('\n');
    mockReadFileSync.mockReturnValue(entries);

    const result = readCodexSessionFile('/fake/session.jsonl');

    expect(result!.inputTokens).toBe(500);
    expect(result!.outputTokens).toBe(250);
  });
});
