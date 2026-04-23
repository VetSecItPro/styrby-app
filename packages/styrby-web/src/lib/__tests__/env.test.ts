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
import { getEnv, requireEnv, getEnvOr, getHttpsUrlEnv } from '../env';

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

describe('getHttpsUrlEnv', () => {
  // WHY these tests exist: on 2026-04-23, the literal placeholder string
  // "PLACEHOLDER_CREATE_UPSTASH_REDIS_DB" was left in Vercel Production from
  // the Phase 2 activation runbook. It passed the raw `process.env.X &&`
  // truthy guard and caused `new Redis({ url })` to throw at module-import
  // time, crashing Next.js build-time page-data collection for
  // /api/webhooks/polar and breaking every Production deploy for 5 hours.
  // getHttpsUrlEnv enforces scheme validation at the boundary so garbage
  // values fall through to the in-memory fallback path instead.

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a valid https URL', () => {
    process.env.STYRBY_TEST_URL = 'https://example.upstash.io';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBe('https://example.upstash.io');
  });

  it('trims whitespace and then validates scheme', () => {
    process.env.STYRBY_TEST_URL = '  https://example.upstash.io\n';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBe('https://example.upstash.io');
  });

  it('returns undefined for the literal placeholder from the activation runbook (primary bug class)', () => {
    process.env.STYRBY_TEST_URL = 'PLACEHOLDER_CREATE_UPSTASH_REDIS_DB';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for an http:// URL (rejects non-TLS)', () => {
    process.env.STYRBY_TEST_URL = 'http://example.upstash.io';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for a redis:// scheme', () => {
    process.env.STYRBY_TEST_URL = 'redis://example.upstash.io:6379';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for a bare host without scheme', () => {
    process.env.STYRBY_TEST_URL = 'example.upstash.io';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for a generic TODO string', () => {
    process.env.STYRBY_TEST_URL = 'TODO';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined when unset', () => {
    delete process.env.STYRBY_TEST_URL;
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for an all-whitespace value', () => {
    process.env.STYRBY_TEST_URL = '   \n';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });

  it('returns undefined for a malformed URL that starts with https:// but fails to parse', () => {
    process.env.STYRBY_TEST_URL = 'https://';
    expect(getHttpsUrlEnv('STYRBY_TEST_URL')).toBeUndefined();
  });
});
