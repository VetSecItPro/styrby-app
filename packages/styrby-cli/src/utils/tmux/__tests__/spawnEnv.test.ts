/**
 * Unit tests for the env-flag construction + shell-escape helpers.
 *
 * WHY: These cover the `tmux new-window -e KEY="VALUE"` path. Bugs here would
 * lead to either silent variable drops or shell injection - both critical for
 * a daemon that handles user-provided agent env.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}));

import { buildEnvFlags, escapeEnvValue } from '../spawnEnv';

describe('escapeEnvValue', () => {
    it('escapes backslash before other characters', () => {
        // Order matters: backslash escapes get applied first, otherwise the
        // backslashes added for quote/dollar/backtick get double-escaped.
        expect(escapeEnvValue('a\\b')).toBe('a\\\\b');
    });

    it('escapes double quotes', () => {
        expect(escapeEnvValue('say "hi"')).toBe('say \\"hi\\"');
    });

    it('escapes dollar signs to neutralize variable expansion', () => {
        expect(escapeEnvValue('$HOME')).toBe('\\$HOME');
    });

    it('escapes backticks to neutralize command substitution', () => {
        expect(escapeEnvValue('`whoami`')).toBe('\\`whoami\\`');
    });

    it('handles plain text unchanged', () => {
        expect(escapeEnvValue('hello-world_42')).toBe('hello-world_42');
    });

    it('handles all dangerous chars in one value', () => {
        expect(escapeEnvValue('\\"$`')).toBe('\\\\\\"\\$\\`');
    });
});

describe('buildEnvFlags', () => {
    it('returns empty array for undefined env', () => {
        expect(buildEnvFlags(undefined)).toEqual([]);
    });

    it('returns empty array for empty object', () => {
        expect(buildEnvFlags({})).toEqual([]);
    });

    it('builds -e KEY="VALUE" pairs for valid entries', () => {
        const flags = buildEnvFlags({ FOO: 'bar', BAZ: 'qux' });
        expect(flags).toEqual([
            '-e', 'FOO="bar"',
            '-e', 'BAZ="qux"',
        ]);
    });

    it('skips invalid env var names', () => {
        const flags = buildEnvFlags({ '1BAD': 'x', GOOD: 'y' });
        expect(flags).toEqual(['-e', 'GOOD="y"']);
    });

    it('skips null/undefined values', () => {
        const flags = buildEnvFlags({
            DROP_ME: undefined as unknown as string,
            KEEP: 'yes',
        });
        expect(flags).toEqual(['-e', 'KEEP="yes"']);
    });

    it('escapes dangerous values inside the quoted form', () => {
        const flags = buildEnvFlags({ TOKEN: 'a"b$c' });
        expect(flags).toEqual(['-e', 'TOKEN="a\\"b\\$c"']);
    });

    it('accepts env names with leading underscore and digits', () => {
        const flags = buildEnvFlags({ _PRIVATE_1: 'ok' });
        expect(flags).toEqual(['-e', '_PRIVATE_1="ok"']);
    });
});
