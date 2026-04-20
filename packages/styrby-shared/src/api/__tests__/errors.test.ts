/**
 * Tests for the unified ApiError envelope (Phase 0.10).
 *
 * @module api/__tests__/errors
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  apiError,
  isApiError,
  assertNoSecretsInDetails,
  API_ERROR_CODES,
} from '../errors.js';

describe('apiError', () => {
  it('returns an envelope with code, message, and ISO timestamp', () => {
    const err = apiError('BAD_REQUEST', 'Missing field "email"');
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('Missing field "email"');
    expect(err.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('attaches details when provided', () => {
    const err = apiError('VALIDATION_FAILED', 'invalid', { field: 'email' });
    expect(err.details).toEqual({ field: 'email' });
  });

  it('attaches requestId when provided', () => {
    const err = apiError('INTERNAL_ERROR', 'oops', undefined, 'req-123');
    expect(err.requestId).toBe('req-123');
  });

  it('accepts arbitrary string codes for migration', () => {
    const err = apiError('CUSTOM_LEGACY_CODE', 'unmigrated route');
    expect(err.code).toBe('CUSTOM_LEGACY_CODE');
  });

  it('exports a stable list of canonical codes', () => {
    expect(API_ERROR_CODES).toContain('UNAUTHORIZED');
    expect(API_ERROR_CODES).toContain('TIER_LIMIT_EXCEEDED');
    expect(API_ERROR_CODES.length).toBeGreaterThan(10);
  });
});

describe('assertNoSecretsInDetails', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('strips secret-shaped keys silently in production', () => {
    process.env.NODE_ENV = 'production';
    const details: Record<string, unknown> = {
      field: 'email',
      password: 'secret-pw',
      api_key: 'sk_live_xxx',
    };
    assertNoSecretsInDetails(details);
    expect(details).toEqual({ field: 'email' });
  });

  it('throws in development when a secret-shaped key is present', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertNoSecretsInDetails({ password: 'pw' })).toThrow(/password/);
  });

  it('does not throw when no forbidden keys are present', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertNoSecretsInDetails({ field: 'email' })).not.toThrow();
  });
});

describe('isApiError type guard', () => {
  it('accepts a well-formed envelope', () => {
    expect(isApiError(apiError('BAD_REQUEST', 'x'))).toBe(true);
  });

  it('rejects a bare string / null / undefined / wrong shape', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError('error')).toBe(false);
    expect(isApiError({ code: 'X' })).toBe(false); // missing message
    expect(isApiError({ code: 'X', message: 'm' })).toBe(false); // missing timestamp
  });
});
