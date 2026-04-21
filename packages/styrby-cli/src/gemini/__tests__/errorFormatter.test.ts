/**
 * Tests for `formatGeminiError`, `classifyPromptError`, and
 * `extractResetTimeSuffix`.
 *
 * The classifier was previously an inlined nested if/else inside
 * `runGemini.ts` — these tests pin every branch documented in the
 * pre-refactor source so future changes can't silently regress them.
 */
import { describe, it, expect } from 'vitest';
import {
  formatGeminiError,
  classifyPromptError,
  extractResetTimeSuffix,
} from '@/gemini/utils/errorFormatter';

describe('extractResetTimeSuffix', () => {
  it('extracts hours/minutes/seconds combo', () => {
    expect(extractResetTimeSuffix('Your quota will reset after 3h20m35s.')).toBe(' Quota resets in 3h20m35s.');
  });

  it('extracts minutes only', () => {
    expect(extractResetTimeSuffix('reset after 5m')).toBe(' Quota resets in 5m.');
  });

  it('returns empty string when no match', () => {
    expect(extractResetTimeSuffix('something unrelated')).toBe('');
  });

  it('returns empty string when match has no time parts', () => {
    expect(extractResetTimeSuffix('reset after')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(extractResetTimeSuffix('Reset After 1h2m3s')).toBe(' Quota resets in 1h2m3s.');
  });
});

describe('formatGeminiError', () => {
  it('classifies AbortError', () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    const r = formatGeminiError(err);
    expect(r.kind).toBe('abort');
    expect(r.message).toBe('Aborted by user');
  });

  it('classifies 404 / model not found by code', () => {
    const r = formatGeminiError({ code: 404, message: 'gone' }, { displayedModel: 'gemini-2.5-flash' });
    expect(r.kind).toBe('model-not-found');
    expect(r.message).toContain('gemini-2.5-flash');
    expect(r.message).toContain('not found');
  });

  it('classifies 404 / model not found by message text', () => {
    const r = formatGeminiError({ message: 'model X not found' });
    expect(r.kind).toBe('model-not-found');
    expect(r.message).toContain('gemini-2.5-pro'); // default
  });

  it('classifies -32603 as empty-response', () => {
    const r = formatGeminiError({ code: -32603, message: 'internal' });
    expect(r.kind).toBe('empty-response');
    expect(r.message).toContain('temporary');
  });

  it('classifies "empty response" details as empty-response', () => {
    const r = formatGeminiError({ data: { details: 'Model returned empty response' } });
    expect(r.kind).toBe('empty-response');
  });

  it('classifies 429 as rate-limit', () => {
    expect(formatGeminiError({ code: 429 }).kind).toBe('rate-limit');
  });

  it('classifies RESOURCE_EXHAUSTED in details as rate-limit', () => {
    expect(
      formatGeminiError({ data: { details: 'RESOURCE_EXHAUSTED' } }).kind,
    ).toBe('rate-limit');
  });

  it('classifies Resource exhausted message as rate-limit', () => {
    expect(formatGeminiError({ message: 'Resource exhausted' }).kind).toBe('rate-limit');
  });

  it('classifies quota errors with reset suffix', () => {
    const r = formatGeminiError({
      data: { details: 'quota exhausted - reset after 1h30m' },
    });
    expect(r.kind).toBe('quota-exceeded');
    expect(r.message).toContain('Quota resets in 1h30m.');
  });

  it('classifies quota errors without reset suffix', () => {
    const r = formatGeminiError({ message: 'quota limit reached' });
    expect(r.kind).toBe('quota-exceeded');
    expect(r.message).not.toContain('Quota resets in');
  });

  it('classifies authentication required', () => {
    const r = formatGeminiError({ message: 'Authentication required' });
    expect(r.kind).toBe('auth-required');
    expect(r.message).toContain('happy gemini project set');
  });

  it('classifies code -32000 as auth-required', () => {
    expect(formatGeminiError({ code: -32000 }).kind).toBe('auth-required');
  });

  it('classifies empty error object as cli-missing', () => {
    const r = formatGeminiError({});
    expect(r.kind).toBe('cli-missing');
    expect(r.message).toContain('@google/gemini-cli');
  });

  it('falls back to error.message when nothing else matches', () => {
    const r = formatGeminiError({ message: 'something weird' });
    expect(r.kind).toBe('unknown');
    expect(r.message).toBe('something weird');
  });

  it('prefers details over message for unknown errors', () => {
    const r = formatGeminiError({ message: 'msg', data: { details: 'detailed' } });
    expect(r.message).toBe('detailed');
  });

  it('handles plain Error (no own keys) as cli-missing fallback', () => {
    // WHY: `new Error('msg')` has no own enumerable keys; the original code
    // path matches that against the empty-error-object branch and assumes
    // the Gemini CLI binary is missing. Pinning the legacy behavior.
    const r = formatGeminiError(new Error('generic'));
    expect(r.kind).toBe('cli-missing');
  });

  it('handles primitives', () => {
    const r = formatGeminiError('a string');
    expect(r.kind).toBe('unknown');
    expect(r.message).toBe('Process error occurred');
  });
});

describe('classifyPromptError', () => {
  it('flags quota errors and never marks them retryable', () => {
    const r = classifyPromptError({ data: { details: 'quota exhausted reset after 2h' } });
    expect(r.isQuotaError).toBe(true);
    expect(r.isRetryable).toBe(false);
    expect(r.quotaResetSuffix).toBe(' Quota resets in 2h.');
  });

  it('flags empty-response errors as retryable', () => {
    const r = classifyPromptError({ message: 'Model stream ended' });
    expect(r.isRetryable).toBe(true);
    expect(r.isQuotaError).toBe(false);
  });

  it('flags -32603 as retryable', () => {
    const r = classifyPromptError({ code: -32603, message: 'internal' });
    expect(r.isRetryable).toBe(true);
  });

  it('does not flag random errors as retryable', () => {
    const r = classifyPromptError({ message: 'something else' });
    expect(r.isRetryable).toBe(false);
    expect(r.isQuotaError).toBe(false);
  });

  it('handles undefined / null safely', () => {
    expect(classifyPromptError(undefined).isRetryable).toBe(false);
    expect(classifyPromptError(null).isRetryable).toBe(false);
  });

  it('reads details from nested data.details first', () => {
    const r = classifyPromptError({ data: { details: 'empty response' }, message: 'fallback' });
    expect(r.details).toBe('empty response');
  });
});
