/**
 * Tests for agent/transport/DefaultTransport.ts
 *
 * Covers:
 * - DefaultTransport constructor: agentName defaults and override
 * - getInitTimeout: returns 60_000 ms
 * - filterStdoutLine: passes valid JSON objects/arrays, drops non-JSON,
 *   drops primitives, drops empty lines
 * - handleStderr: always returns { message: null }
 * - getToolPatterns: returns empty array
 * - isInvestigationTool: always false
 * - getToolCallTimeout: 30s for 'think', 120s otherwise
 * - extractToolNameFromId: always null
 * - determineToolName: returns input toolName unchanged
 * - defaultTransport singleton: exported and works
 *
 * WHY: DefaultTransport is the fallback for ACP agents that don't need custom
 * filtering. Its filterStdoutLine safeguard (JSON-only lines) protects the
 * JSON-RPC parser from crashing on unexpected output — regression-tested here
 * so changes don't silently break other agents.
 *
 * @module agent/transport/__tests__/DefaultTransport
 */

import { describe, it, expect } from 'vitest';
import { DefaultTransport, defaultTransport } from '../DefaultTransport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport(name?: string) {
  return name ? new DefaultTransport(name) : new DefaultTransport();
}

// ===========================================================================
// Constructor
// ===========================================================================

describe('DefaultTransport — constructor', () => {
  it('defaults agentName to "generic-acp"', () => {
    const t = makeTransport();
    expect(t.agentName).toBe('generic-acp');
  });

  it('uses the supplied agent name when provided', () => {
    const t = makeTransport('my-agent');
    expect(t.agentName).toBe('my-agent');
  });
});

// ===========================================================================
// getInitTimeout
// ===========================================================================

describe('DefaultTransport.getInitTimeout', () => {
  it('returns 60_000 ms', () => {
    expect(makeTransport().getInitTimeout()).toBe(60_000);
  });
});

// ===========================================================================
// filterStdoutLine
// ===========================================================================

describe('DefaultTransport.filterStdoutLine', () => {
  it('returns empty/blank lines as null (drop)', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('')).toBeNull();
    expect(t.filterStdoutLine?.('   ')).toBeNull();
    expect(t.filterStdoutLine?.('\t')).toBeNull();
  });

  it('passes through lines that are valid JSON objects', () => {
    const t = makeTransport();
    const line = '{"jsonrpc":"2.0","id":1,"result":{}}';
    expect(t.filterStdoutLine?.(line)).toBe(line);
  });

  it('passes through lines that are valid JSON arrays', () => {
    const t = makeTransport();
    const line = '[{"a":1},{"b":2}]';
    expect(t.filterStdoutLine?.(line)).toBe(line);
  });

  it('drops non-JSON lines (e.g. debug text)', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('Loaded experiment ABC')).toBeNull();
    expect(t.filterStdoutLine?.('Starting ACP server...')).toBeNull();
  });

  it('drops JSON primitives (number, string)', () => {
    const t = makeTransport();
    // A bare number is valid JSON but not a valid JSON-RPC message
    expect(t.filterStdoutLine?.('105887304')).toBeNull();
    expect(t.filterStdoutLine?.('"just a string"')).toBeNull();
  });

  it('drops malformed JSON that starts with { but fails to parse', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('{bad json')).toBeNull();
  });

  it('drops null JSON literal (valid JSON but not an object)', () => {
    const t = makeTransport();
    expect(t.filterStdoutLine?.('null')).toBeNull();
  });
});

// ===========================================================================
// handleStderr
// ===========================================================================

describe('DefaultTransport.handleStderr', () => {
  it('always returns { message: null }', () => {
    const t = makeTransport();
    const result = t.handleStderr('any stderr text', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(result.message).toBeNull();
  });
});

// ===========================================================================
// getToolPatterns
// ===========================================================================

describe('DefaultTransport.getToolPatterns', () => {
  it('returns an empty array', () => {
    expect(makeTransport().getToolPatterns()).toEqual([]);
  });
});

// ===========================================================================
// isInvestigationTool
// ===========================================================================

describe('DefaultTransport.isInvestigationTool', () => {
  it('always returns false regardless of toolCallId', () => {
    const t = makeTransport();
    expect(t.isInvestigationTool('codebase_investigator-123')).toBe(false);
    expect(t.isInvestigationTool('anything')).toBe(false);
  });
});

// ===========================================================================
// getToolCallTimeout
// ===========================================================================

describe('DefaultTransport.getToolCallTimeout', () => {
  it('returns 30_000 for think toolKind', () => {
    expect(makeTransport().getToolCallTimeout('id-1', 'think')).toBe(30_000);
  });

  it('returns 120_000 for all other toolKinds', () => {
    expect(makeTransport().getToolCallTimeout('id-1', 'bash')).toBe(120_000);
    expect(makeTransport().getToolCallTimeout('id-1')).toBe(120_000);
  });
});

// ===========================================================================
// extractToolNameFromId
// ===========================================================================

describe('DefaultTransport.extractToolNameFromId', () => {
  it('always returns null', () => {
    const t = makeTransport();
    expect(t.extractToolNameFromId('change_title-123')).toBeNull();
    expect(t.extractToolNameFromId('anything')).toBeNull();
  });
});

// ===========================================================================
// determineToolName
// ===========================================================================

describe('DefaultTransport.determineToolName', () => {
  it('returns the toolName unchanged for any input', () => {
    const t = makeTransport();
    expect(
      t.determineToolName('read_file', 'call-1', {}, {
        activeToolCalls: new Set(),
        hasActiveInvestigation: false,
      } as any),
    ).toBe('read_file');

    expect(
      t.determineToolName('other', 'call-2', {}, {
        activeToolCalls: new Set(),
        hasActiveInvestigation: false,
      } as any),
    ).toBe('other');
  });
});

// ===========================================================================
// defaultTransport singleton
// ===========================================================================

describe('defaultTransport singleton', () => {
  it('is an instance of DefaultTransport', () => {
    expect(defaultTransport).toBeInstanceOf(DefaultTransport);
  });

  it('has agentName "generic-acp"', () => {
    expect(defaultTransport.agentName).toBe('generic-acp');
  });
});
