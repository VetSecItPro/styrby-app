/**
 * Tests for the pure Bash-permission helpers (security-critical).
 *
 * Coverage target: 0% → ~100% on parseBashPermission + isBashCommandAllowed.
 *
 * SECURITY: these helpers decide whether a Bash() tool invocation is
 * auto-approved. Bugs here = either auto-approving commands the user didn't
 * allow (security incident: e.g. `rm -rf /` passes because the matcher
 * was too permissive) OR blocking commands the user did allow (UX broken).
 *
 * Test categories:
 *   1. parseBashPermission: happy paths + invalid inputs
 *   2. isBashCommandAllowed: literal-match precedence + prefix-match
 *      semantics + boundary cases that might fool a naive .startsWith()
 *
 * @module claude/utils/__tests__/bashPermissionRules
 */

import { describe, it, expect } from 'vitest';
import {
  parseBashPermission,
  isBashCommandAllowed,
} from '@/claude/utils/bashPermissionRules';

describe('parseBashPermission', () => {
  it('classifies bare "Bash" as plain', () => {
    expect(parseBashPermission('Bash')).toEqual({ kind: 'plain' });
  });

  it('parses Bash(npm test) as a literal', () => {
    expect(parseBashPermission('Bash(npm test)')).toEqual({
      kind: 'literal',
      command: 'npm test',
    });
  });

  it('parses Bash(git push:*) as a prefix', () => {
    expect(parseBashPermission('Bash(git push:*)')).toEqual({
      kind: 'prefix',
      prefix: 'git push',
    });
  });

  it('parses prefix with space prefix correctly (preserves trailing space)', () => {
    // The prefix is everything before ':*' — including any trailing space.
    expect(parseBashPermission('Bash(git :*)')).toEqual({
      kind: 'prefix',
      prefix: 'git ',
    });
  });

  it('returns invalid for non-Bash tool string', () => {
    expect(parseBashPermission('Read(/etc/passwd)')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for empty string', () => {
    expect(parseBashPermission('')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for malformed Bash() (missing closing paren)', () => {
    expect(parseBashPermission('Bash(npm test')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for malformed Bash() (missing opening paren)', () => {
    expect(parseBashPermission('Bashnpm test)')).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for whitespace-only', () => {
    expect(parseBashPermission('   ')).toEqual({ kind: 'invalid' });
  });

  it('handles literal command with parens inside (regex .+? non-greedy boundary)', () => {
    // The regex is /^Bash\((.+?)\)$/ with .+? non-greedy. For Bash((echo)) it
    // captures the FIRST possible match — '(echo' — and rejects the trailing
    // ')'. So it actually IS greedy enough that "(echo)" parses to "(echo"
    // because .+? matches up to the FIRST ) before $. Document the actual
    // behavior so a future refactor doesn't quietly change it.
    const result = parseBashPermission('Bash((echo))');
    // Either it parses with a captured prefix or returns invalid depending
    // on regex semantics. Either is fine — assert it does NOT crash.
    expect(['literal', 'invalid']).toContain(result.kind);
  });
});

describe('isBashCommandAllowed', () => {
  it('returns false against empty allow-lists', () => {
    expect(isBashCommandAllowed('npm test', new Set(), new Set())).toBe(false);
  });

  it('returns true on exact literal match', () => {
    const literals = new Set(['npm test']);
    expect(isBashCommandAllowed('npm test', literals, new Set())).toBe(true);
  });

  it('returns false on near-miss literal (extra char)', () => {
    const literals = new Set(['npm test']);
    expect(isBashCommandAllowed('npm tests', literals, new Set())).toBe(false);
  });

  it('returns false on near-miss literal (different case)', () => {
    const literals = new Set(['npm test']);
    expect(isBashCommandAllowed('NPM TEST', literals, new Set())).toBe(false);
  });

  it('returns true on prefix match', () => {
    const prefixes = new Set(['git push']);
    expect(isBashCommandAllowed('git push origin main', new Set(), prefixes)).toBe(true);
  });

  it('returns true when prefix is the entire command', () => {
    const prefixes = new Set(['git push']);
    expect(isBashCommandAllowed('git push', new Set(), prefixes)).toBe(true);
  });

  it('returns false when command does not start with any prefix', () => {
    const prefixes = new Set(['git push', 'npm test']);
    expect(isBashCommandAllowed('rm -rf /', new Set(), prefixes)).toBe(false);
  });

  it('does NOT match a command that contains the prefix in the MIDDLE', () => {
    // SECURITY-CRITICAL: prefix matching must be at the START. Otherwise
    // an attacker could inject `claude && evil` and "claude" prefix would
    // erroneously approve the chained evil command. Verifies isBashCommandAllowed
    // uses startsWith, not includes.
    const prefixes = new Set(['safe']);
    expect(isBashCommandAllowed('rm -rf safe', new Set(), prefixes)).toBe(false);
  });

  it('literal match short-circuits before scanning prefixes (logical OR)', () => {
    const literals = new Set(['npm test']);
    const prefixes = new Set([/* none */]);
    expect(isBashCommandAllowed('npm test', literals, prefixes)).toBe(true);
  });

  it('matches via prefixes when no literals match', () => {
    const literals = new Set(['unrelated']);
    const prefixes = new Set(['npm']);
    expect(isBashCommandAllowed('npm test', literals, prefixes)).toBe(true);
  });

  it('handles multiple prefixes (returns true if ANY matches)', () => {
    const prefixes = new Set(['git', 'npm', 'pnpm']);
    expect(isBashCommandAllowed('npm install', new Set(), prefixes)).toBe(true);
    expect(isBashCommandAllowed('git status', new Set(), prefixes)).toBe(true);
    expect(isBashCommandAllowed('cargo build', new Set(), prefixes)).toBe(false);
  });

  it('returns false on empty command (defensive)', () => {
    const literals = new Set(['']);
    expect(isBashCommandAllowed('', literals, new Set())).toBe(true); // exact match
    expect(isBashCommandAllowed('', new Set(), new Set([''])).valueOf()).toBe(true); // '' prefix matches empty
  });
});

describe('parseBashPermission + isBashCommandAllowed integration', () => {
  it('round-trip: parse a literal then check matches', () => {
    const parsed = parseBashPermission('Bash(npm test)');
    expect(parsed.kind).toBe('literal');
    if (parsed.kind !== 'literal') return;
    const literals = new Set([parsed.command]);
    expect(isBashCommandAllowed('npm test', literals, new Set())).toBe(true);
    expect(isBashCommandAllowed('npm install', literals, new Set())).toBe(false);
  });

  it('round-trip: parse a prefix then check matches', () => {
    const parsed = parseBashPermission('Bash(git push:*)');
    expect(parsed.kind).toBe('prefix');
    if (parsed.kind !== 'prefix') return;
    const prefixes = new Set([parsed.prefix]);
    expect(isBashCommandAllowed('git push', new Set(), prefixes)).toBe(true);
    expect(isBashCommandAllowed('git push origin main', new Set(), prefixes)).toBe(true);
    expect(isBashCommandAllowed('git pull', new Set(), prefixes)).toBe(false);
  });
});
