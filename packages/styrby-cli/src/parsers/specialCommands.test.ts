import { describe, it, expect } from 'vitest';
import { parseCompact, parseClear, parseSpecialCommand } from './specialCommands';

describe('parseCompact', () => {
    it('should parse /compact command with argument', () => {
        const result = parseCompact('/compact optimize the code');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact optimize the code');
    });

    it('should parse /compact command without argument', () => {
        const result = parseCompact('/compact');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact');
    });

    it('should not parse regular messages', () => {
        const result = parseCompact('hello world');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('hello world');
    });

    it('should not parse messages that contain compact but do not start with /compact', () => {
        const result = parseCompact('please /compact this');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('please /compact this');
    });
});

describe('parseClear', () => {
    it('should parse /clear command exactly', () => {
        const result = parseClear('/clear');
        expect(result.isClear).toBe(true);
    });

    it('should parse /clear command with whitespace', () => {
        const result = parseClear('  /clear  ');
        expect(result.isClear).toBe(true);
    });

    it('should not parse /clear with arguments', () => {
        const result = parseClear('/clear something');
        expect(result.isClear).toBe(false);
    });

    it('should not parse regular messages', () => {
        const result = parseClear('hello world');
        expect(result.isClear).toBe(false);
    });
});

describe('parseSpecialCommand', () => {
    it('should detect compact command', () => {
        const result = parseSpecialCommand('/compact optimize');
        expect(result.type).toBe('compact');
        expect(result.originalMessage).toBe('/compact optimize');
    });

    it('should detect clear command', () => {
        const result = parseSpecialCommand('/clear');
        expect(result.type).toBe('clear');
        expect(result.originalMessage).toBeUndefined();
    });

    it('should return null for regular messages', () => {
        const result = parseSpecialCommand('hello world');
        expect(result.type).toBeNull();
        expect(result.originalMessage).toBeUndefined();
    });

    it('should handle edge cases correctly', () => {
        // Test with extra whitespace
        expect(parseSpecialCommand('  /compact test  ').type).toBe('compact');
        expect(parseSpecialCommand('  /clear  ').type).toBe('clear');

        // Test partial matches should not trigger
        expect(parseSpecialCommand('some /compact text').type).toBeNull();
        expect(parseSpecialCommand('/compactor').type).toBeNull();
        expect(parseSpecialCommand('/clearing').type).toBeNull();
    });
});

// ============================================================================
// Additional edge-case coverage
// ============================================================================

describe('parseCompact — additional edge cases', () => {
    it('preserves multi-word arguments verbatim', () => {
        const result = parseCompact('/compact summarize and keep all tool calls');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact summarize and keep all tool calls');
    });

    it('handles empty string as non-compact', () => {
        const result = parseCompact('');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('');
    });

    it('handles string with only whitespace as non-compact', () => {
        // WHY: trim() collapses whitespace-only strings to '', which won't
        // match '/compact', so isCompact must be false.
        const result = parseCompact('   ');
        expect(result.isCompact).toBe(false);
    });

    it('does not match /compactor (no space after /compact)', () => {
        // Must start with "/compact " (trailing space) or be exactly "/compact"
        expect(parseCompact('/compactor').isCompact).toBe(false);
    });

    it('returns trimmed originalMessage for bare /compact', () => {
        const result = parseCompact('  /compact  ');
        expect(result.isCompact).toBe(true);
        // originalMessage is set to trimmed value
        expect(result.originalMessage).toBe('/compact');
    });
});

describe('parseClear — additional edge cases', () => {
    it('handles empty string', () => {
        expect(parseClear('').isClear).toBe(false);
    });

    it('does not match /clear followed by slash (e.g., /clear/context)', () => {
        expect(parseClear('/clear/context').isClear).toBe(false);
    });

    it('does not match prefix substring (e.g., /clea)', () => {
        expect(parseClear('/clea').isClear).toBe(false);
    });
});

describe('parseSpecialCommand — priority ordering', () => {
    it('compact takes priority and is checked before clear', () => {
        // Sanity check: the /compact branch runs before the /clear branch,
        // so a message like "/compact /clear test" resolves as compact.
        const result = parseSpecialCommand('/compact /clear test');
        expect(result.type).toBe('compact');
    });

    it('returns null type and no originalMessage for truly unrecognised input', () => {
        const result = parseSpecialCommand('/unknown-command');
        expect(result.type).toBeNull();
        expect(result.originalMessage).toBeUndefined();
    });
});