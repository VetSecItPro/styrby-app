/**
 * Tests for the env accessor helpers.
 *
 * WHY these tests exist: on 2026-04-20 a trailing-newline in a Vercel env
 * var crashed `/api/sessions` at module-import time. `getEnv()` /
 * `requireEnv()` / `getEnvOr()` were introduced as the defensive boundary
 * for all security-sensitive env reads. These tests lock in the trim
 * semantics so a future refactor cannot silently re-expose the bug class.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnv, requireEnv, getEnvOr } from '../env';

// Save a snapshot of process.env for teardown; we mutate it in-place in tests.
const originalEnv = { ...process.env };

describe('getEnv', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the value when set and non-empty', () => {
    process.env.STYRBY_TEST_VAR = 'hello';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('hello');
  });

  it('returns undefined when unset', () => {
    delete process.env.STYRBY_TEST_VAR;
    expect(getEnv('STYRBY_TEST_VAR')).toBeUndefined();
  });

  it('trims a trailing newline (primary bug class — Vercel paste error)', () => {
    process.env.STYRBY_TEST_VAR = 'https://styrbyapp.com\n';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('https://styrbyapp.com');
  });

  it('trims a trailing CRLF', () => {
    process.env.STYRBY_TEST_VAR = 'https://styrbyapp.com\r\n';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('https://styrbyapp.com');
  });

  it('trims leading and trailing whitespace', () => {
    process.env.STYRBY_TEST_VAR = '   eyJhbGciOi...   ';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('eyJhbGciOi...');
  });

  it('trims tabs', () => {
    process.env.STYRBY_TEST_VAR = '\tsecret\t';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('secret');
  });

  it('returns undefined for a value that trims to empty (all-whitespace)', () => {
    process.env.STYRBY_TEST_VAR = '   \n\t  ';
    expect(getEnv('STYRBY_TEST_VAR')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    process.env.STYRBY_TEST_VAR = '';
    expect(getEnv('STYRBY_TEST_VAR')).toBeUndefined();
  });

  it('preserves internal whitespace (only trims edges)', () => {
    // Not that a real env var would contain spaces, but verify we don't
    // accidentally collapse/replace internal characters.
    process.env.STYRBY_TEST_VAR = '  a b c  ';
    expect(getEnv('STYRBY_TEST_VAR')).toBe('a b c');
  });
});

describe('requireEnv', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the trimmed value when set', () => {
    process.env.STYRBY_TEST_VAR = 'real-secret\n';
    expect(requireEnv('STYRBY_TEST_VAR')).toBe('real-secret');
  });

  it('throws when unset', () => {
    delete process.env.STYRBY_TEST_VAR;
    expect(() => requireEnv('STYRBY_TEST_VAR')).toThrow(/STYRBY_TEST_VAR/);
  });

  it('throws when value trims to empty', () => {
    process.env.STYRBY_TEST_VAR = '   \n';
    expect(() => requireEnv('STYRBY_TEST_VAR')).toThrow(/STYRBY_TEST_VAR/);
  });

  it('error message names the missing variable for fast diagnosis', () => {
    delete process.env.STYRBY_TEST_VAR;
    try {
      requireEnv('STYRBY_TEST_VAR');
    } catch (err) {
      expect((err as Error).message).toContain('STYRBY_TEST_VAR');
      expect((err as Error).message).toContain('unset or blank');
    }
  });
});

describe('getEnvOr', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the trimmed env value when set', () => {
    process.env.STYRBY_TEST_VAR = 'override\n';
    expect(getEnvOr('STYRBY_TEST_VAR', 'default')).toBe('override');
  });

  it('returns the fallback when unset', () => {
    delete process.env.STYRBY_TEST_VAR;
    expect(getEnvOr('STYRBY_TEST_VAR', 'default')).toBe('default');
  });

  it('returns the fallback when env value trims to empty', () => {
    process.env.STYRBY_TEST_VAR = '  \n';
    expect(getEnvOr('STYRBY_TEST_VAR', 'default')).toBe('default');
  });
});
