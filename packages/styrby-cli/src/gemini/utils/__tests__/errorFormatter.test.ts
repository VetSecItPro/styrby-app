/**
 * Tests for gemini/utils/errorFormatter.ts.
 *
 * Coverage target: 0% → 95%+ on the 3 exported pure functions
 * (extractResetTimeSuffix, formatGeminiError, classifyPromptError).
 *
 * The file's own JSDoc says it is "fully pure and unit-testable" — this
 * test file delivers on that claim. Each error category from the source
 * gets at least one test; classifyPromptError's retry-vs-quota dispatch
 * gets explicit boundary tests because its decisions drive the loop's
 * retry policy in production.
 *
 * @module gemini/utils/__tests__/errorFormatter
 */

import { describe, it, expect } from 'vitest';
import {
  extractResetTimeSuffix,
  formatGeminiError,
  classifyPromptError,
} from '@/gemini/utils/errorFormatter';

describe('extractResetTimeSuffix', () => {
  it('extracts hour-minute-second reset time', () => {
    expect(extractResetTimeSuffix('quota will reset after 3h20m35s for this account')).toBe(
      ' Quota resets in 3h20m35s.'
    );
  });

  it('extracts minute-only reset', () => {
    expect(extractResetTimeSuffix('reset after 45m')).toBe(' Quota resets in 45m.');
  });

  it('extracts hour-only reset', () => {
    expect(extractResetTimeSuffix('reset after 2h')).toBe(' Quota resets in 2h.');
  });

  it('returns empty when no match', () => {
    expect(extractResetTimeSuffix('totally unrelated message')).toBe('');
    expect(extractResetTimeSuffix('')).toBe('');
  });

  it('returns empty when "reset after" exists but no time follows', () => {
    expect(extractResetTimeSuffix('reset after no-time-here')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(extractResetTimeSuffix('RESET AFTER 1h')).toBe(' Quota resets in 1h.');
  });
});

describe('formatGeminiError', () => {
  it('classifies AbortError as abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = formatGeminiError(err);
    expect(result.kind).toBe('abort');
    expect(result.message).toBe('Aborted by user');
  });

  it('classifies code 404 as model-not-found', () => {
    const result = formatGeminiError({ code: 404, message: 'not found' });
    expect(result.kind).toBe('model-not-found');
    expect(result.message).toContain('Model "gemini-2.5-pro" not found');
  });

  it('uses ctx.displayedModel in model-not-found message when provided', () => {
    const result = formatGeminiError(
      { code: 404, message: 'not found' },
      { displayedModel: 'gemini-2.5-flash' }
    );
    expect(result.message).toContain('Model "gemini-2.5-flash" not found');
  });

  it('classifies code -32603 as empty-response', () => {
    const result = formatGeminiError({ code: -32603, message: 'internal' });
    expect(result.kind).toBe('empty-response');
    expect(result.message).toContain('empty response');
  });

  it('classifies code 429 as rate-limit', () => {
    const result = formatGeminiError({ code: 429, message: 'rate limited' });
    expect(result.kind).toBe('rate-limit');
    expect(result.message).toContain('rate limit exceeded');
  });

  it('classifies RESOURCE_EXHAUSTED in details as rate-limit', () => {
    const result = formatGeminiError({
      data: { details: 'RESOURCE_EXHAUSTED' },
      message: 'fail',
    });
    expect(result.kind).toBe('rate-limit');
  });

  it('classifies "quota" in message as quota-exceeded with reset-time', () => {
    const result = formatGeminiError({
      message: 'quota exceeded; reset after 1h30m',
    });
    expect(result.kind).toBe('quota-exceeded');
    expect(result.message).toContain('Quota resets in 1h30m');
  });

  it('classifies "Authentication required" message as auth-required', () => {
    const result = formatGeminiError({ message: 'Authentication required' });
    expect(result.kind).toBe('auth-required');
    expect(result.message).toContain('Google Cloud Project');
  });

  it('classifies code -32000 as auth-required', () => {
    const result = formatGeminiError({ code: -32000, message: 'fail' });
    expect(result.kind).toBe('auth-required');
  });

  it('classifies empty error object as cli-missing', () => {
    const result = formatGeminiError({});
    expect(result.kind).toBe('cli-missing');
    expect(result.message).toContain('npm install -g @google/gemini-cli');
  });

  it('classifies unknown structured error as unknown with extracted message', () => {
    const result = formatGeminiError({ message: 'something broke', code: 500 });
    expect(result.kind).toBe('unknown');
    expect(result.message).toBe('something broke');
  });

  it('classifies plain Error (without enumerable keys) as cli-missing per code path', () => {
    // QUIRK: a plain `new Error('msg')` has zero enumerable own properties
    // (.message and .name are non-enumerable), so the
    // `Object.keys(error).length === 0` branch fires before falling through
    // to the generic Error handler. Documenting the actual behavior so
    // future refactors don't accidentally change it without realizing.
    const result = formatGeminiError(new Error('plain error'));
    expect(result.kind).toBe('cli-missing');
  });

  it('classifies an Error with enumerable .message as unknown', () => {
    // To hit the truly-unknown branch you need a non-empty enumerable obj
    // that doesn't match any specific category. Make .message enumerable:
    const err = new Error('plain error');
    Object.defineProperty(err, 'message', { value: 'plain error', enumerable: true });
    const result = formatGeminiError(err);
    expect(result.kind).toBe('unknown');
    expect(result.message).toBe('plain error');
  });

  it('classifies non-object/non-Error as unknown with default message', () => {
    expect(formatGeminiError('string error').kind).toBe('unknown');
    expect(formatGeminiError(undefined).kind).toBe('unknown');
    expect(formatGeminiError(null).kind).toBe('unknown');
  });
});

describe('classifyPromptError', () => {
  it('marks empty-response details as retryable', () => {
    const result = classifyPromptError({ data: { details: 'empty response from model' } });
    expect(result.isRetryable).toBe(true);
    expect(result.isQuotaError).toBe(false);
  });

  it('marks "Model stream ended" as retryable', () => {
    const result = classifyPromptError({ data: { details: 'Model stream ended unexpectedly' } });
    expect(result.isRetryable).toBe(true);
  });

  it('marks code -32603 as retryable', () => {
    const result = classifyPromptError({ code: -32603, message: 'internal' });
    expect(result.isRetryable).toBe(true);
  });

  it('marks quota errors as quota (NOT retryable)', () => {
    const result = classifyPromptError({ message: 'quota exceeded' });
    expect(result.isQuotaError).toBe(true);
    expect(result.isRetryable).toBe(false);
  });

  it('extracts quotaResetSuffix when quota error has reset time', () => {
    const result = classifyPromptError({
      message: 'quota exceeded; reset after 2h15m',
    });
    expect(result.isQuotaError).toBe(true);
    expect(result.quotaResetSuffix).toBe(' Quota resets in 2h15m.');
  });

  it('marks RESOURCE_EXHAUSTED in details as quota (capacity)', () => {
    const result = classifyPromptError({
      data: { details: 'RESOURCE_EXHAUSTED: capacity full' },
    });
    expect(result.isQuotaError).toBe(true);
  });

  it('returns isRetryable=false + isQuotaError=false for unrelated errors', () => {
    const result = classifyPromptError({ message: 'totally unrelated' });
    expect(result.isRetryable).toBe(false);
    expect(result.isQuotaError).toBe(false);
  });

  it('handles non-object errors without throwing', () => {
    expect(classifyPromptError(null).isRetryable).toBe(false);
    expect(classifyPromptError(undefined).isRetryable).toBe(false);
    expect(classifyPromptError('string').isRetryable).toBe(false);
  });

  it('extracts details field from .details (not just .data.details)', () => {
    const result = classifyPromptError({ details: 'empty response' });
    expect(result.details).toBe('empty response');
    expect(result.isRetryable).toBe(true);
  });

  it('falls back to .message for details when neither .data.details nor .details set', () => {
    const result = classifyPromptError({ message: 'some message text' });
    expect(result.details).toBe('some message text');
  });
});
