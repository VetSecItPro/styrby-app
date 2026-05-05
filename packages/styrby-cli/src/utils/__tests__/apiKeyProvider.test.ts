/**
 * Tests for utils/apiKeyProvider.ts
 *
 * Locks down the prefix-sniff heuristics + resolveApiKeyEnv() fallback
 * behavior so the audit-2026-05-05 HIGH fix doesn't silently regress.
 *
 * @module utils/__tests__/apiKeyProvider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '@/ui/logger';
import {
  detectApiKeyProvider,
  envVarsForProvider,
  resolveApiKeyEnv,
} from '../apiKeyProvider';

describe('detectApiKeyProvider', () => {
  it.each([
    ['sk-ant-abc123', 'anthropic'],
    ['sk-ant-xyz', 'anthropic'],
  ] as const)('detects anthropic from %s', (key, expected) => {
    expect(detectApiKeyProvider(key)).toBe(expected);
  });

  it.each([
    ['sk-openai-abc', 'openai'],
    ['sk-proj-xyz', 'openai'],
    ['sess-foo', 'openai'],
  ] as const)('detects openai from %s', (key, expected) => {
    expect(detectApiKeyProvider(key)).toBe(expected);
  });

  it.each([
    ['AIzaSyAbcDef', 'google'],
    ['AIzaABCDEF', 'google'],
  ] as const)('detects google from %s', (key, expected) => {
    expect(detectApiKeyProvider(key)).toBe(expected);
  });

  it('returns unknown for empty / opaque keys', () => {
    expect(detectApiKeyProvider('')).toBe('unknown');
    expect(detectApiKeyProvider('opaque-token-no-prefix')).toBe('unknown');
    expect(detectApiKeyProvider('mistral-foo')).toBe('unknown');
  });

  it('does NOT confuse sk-ant- with sk-', () => {
    expect(detectApiKeyProvider('sk-ant-foo')).toBe('anthropic');
    expect(detectApiKeyProvider('sk-foo')).toBe('openai');
  });
});

describe('envVarsForProvider', () => {
  it('anthropic: ANTHROPIC_API_KEY only', () => {
    expect(envVarsForProvider('anthropic', 'k')).toEqual({ ANTHROPIC_API_KEY: 'k' });
  });
  it('openai: OPENAI_API_KEY only', () => {
    expect(envVarsForProvider('openai', 'k')).toEqual({ OPENAI_API_KEY: 'k' });
  });
  it('google: GOOGLE + GEMINI', () => {
    expect(envVarsForProvider('google', 'k')).toEqual({
      GOOGLE_API_KEY: 'k',
      GEMINI_API_KEY: 'k',
    });
  });
  it('mistral: MISTRAL_API_KEY only', () => {
    expect(envVarsForProvider('mistral', 'k')).toEqual({ MISTRAL_API_KEY: 'k' });
  });
  it('unknown: empty object', () => {
    expect(envVarsForProvider('unknown', 'k')).toEqual({});
  });
});

describe('resolveApiKeyEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns {} when apiKey is undefined', () => {
    expect(resolveApiKeyEnv(undefined, ['ANTHROPIC_API_KEY'], undefined, 'X')).toEqual({});
  });

  it('explicit provider wins over sniffing', () => {
    // Key prefix sniffs as openai, but caller forces anthropic.
    const env = resolveApiKeyEnv('sk-foo', ['ANTHROPIC_API_KEY'], 'anthropic', 'X');
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-foo' });
  });

  it('sniffs from prefix when no explicit provider', () => {
    expect(resolveApiKeyEnv('sk-ant-foo', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], undefined, 'X'))
      .toEqual({ ANTHROPIC_API_KEY: 'sk-ant-foo' });
  });

  it('falls back to legacy fan-out + warn when sniff returns unknown', () => {
    const env = resolveApiKeyEnv(
      'opaque-token-xyz',
      ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
      undefined,
      'GooseBackend',
    );
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'opaque-token-xyz',
      OPENAI_API_KEY: 'opaque-token-xyz',
      GOOGLE_API_KEY: 'opaque-token-xyz',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as any).mock.calls[0][0]).toMatch(/DEPRECATED/);
  });

  it('does NOT warn when provider is detected', () => {
    resolveApiKeyEnv('sk-ant-foo', ['ANTHROPIC_API_KEY'], undefined, 'X');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('explicit "unknown" provider triggers sniff (not legacy fallback)', () => {
    const env = resolveApiKeyEnv('sk-ant-foo', ['ANTHROPIC_API_KEY'], 'unknown', 'X');
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-foo' });
  });
});
