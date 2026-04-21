/**
 * Tests for agent/transport/handlers/GeminiTransport.ts
 *
 * Covers:
 * - getInitTimeout: returns 120_000 (2 minutes)
 * - filterStdoutLine: drops blank/non-JSON, passes valid JSON objects/arrays,
 *   drops JSON primitives and malformed JSON
 * - handleStderr: rate-limit suppression, 404 model-not-found error emission,
 *   investigation context logging, benign stderr passthrough
 * - isInvestigationTool: codebase_investigator detection by ID and toolKind
 * - getToolCallTimeout: investigation → 600s, think → 30s, default → 120s
 * - extractToolNameFromId: maps known tool-name patterns to canonical names
 * - determineToolName: priority chain — known name → ID extraction → input
 *   field matching → empty-input default → original name
 * - geminiTransport singleton
 *
 * WHY: GeminiTransport is the most complex transport handler. Mistakes in
 * filterStdoutLine crash the JSON-RPC parser. Mistakes in determineToolName
 * cause "other" to show in the mobile tool-call list instead of the real tool.
 *
 * @module agent/transport/__tests__/GeminiTransport
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiTransport, geminiTransport } from '../handlers/GeminiTransport';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport() {
  return new GeminiTransport();
}

function makeCtx(hasActiveInvestigation = false) {
  return {
    activeToolCalls: new Set<string>(),
    hasActiveInvestigation,
  };
}

// ===========================================================================
// getInitTimeout
// ===========================================================================

describe('GeminiTransport.getInitTimeout', () => {
  it('returns 120_000 ms (2 minutes for Gemini CLI warm-up)', () => {
    expect(makeTransport().getInitTimeout()).toBe(120_000);
  });
});

// ===========================================================================
// filterStdoutLine
// ===========================================================================

describe('GeminiTransport.filterStdoutLine', () => {
  it('drops empty/blank lines', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('')).toBeNull();
    expect(t.filterStdoutLine?.('   ')).toBeNull();
  });

  it('drops non-JSON debug output', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('Loaded experiment ABC')).toBeNull();
    expect(t.filterStdoutLine?.('[INFO] ACP starting')).toBeNull();
  });

  it('passes valid JSON-RPC object lines', () => {
    const t = makeTransport();
    const line = '{"jsonrpc":"2.0","method":"session.update","params":{}}';
    expect(t.filterStdoutLine?.(line)).toBe(line);
  });

  it('passes valid JSON array lines', () => {
    const t = makeTransport();
    const line = '[{"a":1}]';
    expect(t.filterStdoutLine?.(line)).toBe(line);
  });

  it('drops bare JSON numbers (not valid ACP messages)', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('105887304')).toBeNull();
  });

  it('drops null JSON literal', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('null')).toBeNull();
  });

  it('drops malformed JSON starting with {', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('{not valid')).toBeNull();
  });
});

// ===========================================================================
// handleStderr
// ===========================================================================

describe('GeminiTransport.handleStderr', () => {
  it('suppresses empty/blank stderr without emitting a message', () => {
    const t = makeTransport();
    const result = t.handleStderr('   ', makeCtx());
    expect(result.message).toBeNull();
  });

  it('suppresses rate-limit 429 errors (Gemini CLI retries internally)', () => {
    const t = makeTransport();
    for (const text of [
      'received status 429 from API',
      'code":429,"message"',
      'rateLimitExceeded error',
      'RESOURCE_EXHAUSTED quota',
    ]) {
      const result = t.handleStderr(text, makeCtx());
      expect(result.message).toBeNull();
    }
  });

  it('emits status error with available models list on 404 model-not-found', () => {
    const t = makeTransport();
    const result = t.handleStderr('received status 404 from API', makeCtx());

    expect(result.message).not.toBeNull();
    expect(result.message?.type).toBe('status');
    expect((result.message as any).status).toBe('error');
    expect((result.message as any).detail).toContain('gemini-2.5-pro');
  });

  it('emits status error on code":404 variant', () => {
    const t = makeTransport();
    const result = t.handleStderr('{"code":404,"message":"not found"}', makeCtx());
    expect(result.message?.type).toBe('status');
  });

  it('returns null message for benign debug output during investigation', () => {
    const t = makeTransport();
    const result = t.handleStderr('Starting file scan...', makeCtx(true));
    expect(result.message).toBeNull();
  });

  it('logs (but does not emit) error/timeout messages during investigation', () => {
    const t = makeTransport();
    const result = t.handleStderr('timeout: investigation took too long', makeCtx(true));
    // Suppressed via null message — investigation might recover
    expect(result.message).toBeNull();
  });

  it('returns null message for ordinary stderr outside investigation context', () => {
    const t = makeTransport();
    const result = t.handleStderr('some debug info', makeCtx(false));
    expect(result.message).toBeNull();
  });
});

// ===========================================================================
// isInvestigationTool
// ===========================================================================

describe('GeminiTransport.isInvestigationTool', () => {
  it('returns true for toolCallId containing "codebase_investigator"', () => {
    const t = makeTransport();
    expect(t.isInvestigationTool('codebase_investigator-123456')).toBe(true);
  });

  it('returns true for toolCallId containing "investigator"', () => {
    const t = makeTransport();
    expect(t.isInvestigationTool('my-investigator-tool')).toBe(true);
  });

  it('returns true when toolKind contains "investigator"', () => {
    const t = makeTransport();
    expect(t.isInvestigationTool('other-id', 'codebase_investigator')).toBe(true);
  });

  it('returns false for unrelated tool IDs', () => {
    const t = makeTransport();
    expect(t.isInvestigationTool('read_file-001')).toBe(false);
    expect(t.isInvestigationTool('think-001', 'think')).toBe(false);
  });
});

// ===========================================================================
// getToolCallTimeout
// ===========================================================================

describe('GeminiTransport.getToolCallTimeout', () => {
  it('returns 600_000 for investigation tools', () => {
    const t = makeTransport();
    expect(t.getToolCallTimeout('codebase_investigator-123')).toBe(600_000);
  });

  it('returns 30_000 for think toolKind', () => {
    const t = makeTransport();
    expect(t.getToolCallTimeout('think-001', 'think')).toBe(30_000);
  });

  it('returns 120_000 for all other tools', () => {
    const t = makeTransport();
    expect(t.getToolCallTimeout('write_file-001', 'write')).toBe(120_000);
    expect(t.getToolCallTimeout('bash-001')).toBe(120_000);
  });
});

// ===========================================================================
// extractToolNameFromId
// ===========================================================================

describe('GeminiTransport.extractToolNameFromId', () => {
  it('extracts "change_title" from an ID containing that pattern', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('change_title-1765385846663')).toBe('change_title');
  });

  it('extracts "save_memory" from a matching ID', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('save_memory-001')).toBe('save_memory');
  });

  it('extracts "think" from a matching ID', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('think-001')).toBe('think');
  });

  it('returns null for unknown tool IDs', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('bash-99999')).toBeNull();
    expect(t.extractToolNameFromId('random-id')).toBeNull();
  });

  it('is case-insensitive', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('CHANGE_TITLE-000')).toBe('change_title');
  });
});

// ===========================================================================
// determineToolName — priority chain
// ===========================================================================

describe('GeminiTransport.determineToolName', () => {
  it('returns the original toolName when it is not "other" or "Unknown tool"', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('read_file', 'call-123', {}, makeCtx() as any),
    ).toBe('read_file');
  });

  it('resolves "other" via toolCallId pattern (priority 1)', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('other', 'change_title-1234', {}, makeCtx() as any),
    ).toBe('change_title');
  });

  it('resolves "other" via input field signature (priority 2, when ID is unknown)', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('other', 'unknown-id-99', { memory: 'some content' }, makeCtx() as any),
    ).toBe('save_memory');
  });

  it('resolves "other" to change_title default for empty input (priority 3)', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('other', 'unknown-id-99', {}, makeCtx() as any),
    ).toBe('change_title');
  });

  it('resolves "Unknown tool" string to extracted name from ID', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('Unknown tool', 'think-001', {}, makeCtx() as any),
    ).toBe('think');
  });

  it('returns original name when no heuristic matches', () => {
    const t = makeTransport();
    // Non-empty input with no known fields, unknown ID, non-"other" name bypass
    const result = t.determineToolName(
      'Unknown tool',
      'unrecognized-555',
      { randomKey: 'value' },
      makeCtx() as any,
    );
    expect(result).toBe('Unknown tool');
  });
});

// ===========================================================================
// geminiTransport singleton
// ===========================================================================

describe('geminiTransport singleton', () => {
  it('is an instance of GeminiTransport', () => {
    expect(geminiTransport).toBeInstanceOf(GeminiTransport);
  });

  it('has agentName "gemini"', () => {
    expect(geminiTransport.agentName).toBe('gemini');
  });
});
