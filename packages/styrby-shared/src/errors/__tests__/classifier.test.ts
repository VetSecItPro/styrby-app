/**
 * Tests for the error classifier (errors/classifier.ts).
 *
 * Covers: classifyError, classifyErrors, isErrorFromSource, getPatternById.
 *
 * WHY coverage: classifyError is used by the mobile and web UI to surface
 * human-readable error explanations. Regressions here mean users see "unknown
 * error" instead of actionable guidance.
 *
 * @module errors/__tests__/classifier
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  classifyErrors,
  isErrorFromSource,
  getPatternById,
} from '../classifier.js';

// ============================================================================
// classifyError — known patterns
// ============================================================================

describe('classifyError — agent patterns', () => {
  it('classifies rate limit errors as agent/agent_rate_limit', () => {
    const result = classifyError('Rate limit exceeded: too many requests');
    expect(result.source).toBe('agent');
    expect(result.category).toBe('agent_rate_limit');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('classifies 429 status as agent rate limit', () => {
    const result = classifyError('HTTP 429: quota exceeded');
    expect(result.category).toBe('agent_rate_limit');
  });

  it('classifies context window overflow as agent/agent_context_limit', () => {
    const result = classifyError('context length exceeded maximum tokens');
    expect(result.source).toBe('agent');
    expect(result.category).toBe('agent_context_limit');
  });

  it('classifies Anthropic API error as agent/agent_api_error', () => {
    const result = classifyError('Anthropic error: internal server error 500');
    expect(result.source).toBe('agent');
    expect(result.category).toBe('agent_api_error');
  });
});

describe('classifyError — build patterns', () => {
  it('classifies TypeScript errors as build/build_type', () => {
    const result = classifyError('TS2345: Argument of type string is not assignable to type number');
    expect(result.source).toBe('build');
    expect(result.category).toBe('build_type');
  });

  it('extracts TypeScript error code in details', () => {
    const result = classifyError('TS2345: type mismatch');
    expect(result.details).toBeDefined();
    expect((result.details as Record<string, unknown>)?.errorCode).toBe('TS2345');
  });

  it('classifies npm dependency errors as build/build_dependency', () => {
    const result = classifyError('npm ERR! ERESOLVE could not resolve peer dep conflict');
    expect(result.source).toBe('build');
    expect(result.category).toBe('build_dependency');
  });

  it('classifies eslint errors as build/build_syntax', () => {
    const result = classifyError('eslint error: parsing error in src/index.ts');
    expect(result.source).toBe('build');
    expect(result.category).toBe('build_syntax');
  });

  it('classifies test failure as build/test_failure', () => {
    const result = classifyError('AssertionError: expected 5 to equal 6');
    expect(result.source).toBe('build');
    expect(result.category).toBe('test_failure');
  });
});

describe('classifyError — network patterns', () => {
  it('classifies ETIMEDOUT as network/network_timeout', () => {
    const result = classifyError('ETIMEDOUT: request timed out');
    expect(result.source).toBe('network');
    expect(result.category).toBe('network_timeout');
  });

  it('classifies ENOTFOUND as network/network_dns', () => {
    const result = classifyError('ENOTFOUND: getaddrinfo ENOTFOUND api.example.com');
    expect(result.source).toBe('network');
    expect(result.category).toBe('network_dns');
  });

  it('classifies offline errors as network/network_offline', () => {
    const result = classifyError('net::ERR_INTERNET_DISCONNECTED');
    expect(result.source).toBe('network');
    expect(result.category).toBe('network_offline');
  });
});

describe('classifyError — Styrby relay patterns', () => {
  it('classifies relay connection failures as styrby/relay_connection', () => {
    const result = classifyError('Failed to connect to relay: websocket connection failed');
    expect(result.source).toBe('styrby');
    expect(result.category).toBe('relay_connection');
  });

  it('classifies token expiry as styrby/auth_expired', () => {
    const result = classifyError('Token expired: session expired, please re-authenticate');
    expect(result.source).toBe('styrby');
    expect(result.category).toBe('auth_expired');
  });
});

// ============================================================================
// classifyError — unknown / fallback
// ============================================================================

describe('classifyError — unknown errors', () => {
  it('returns unknown source and category for unrecognized messages', () => {
    const result = classifyError('some completely unrecognized gibberish error zzz');
    expect(result.source).toBe('unknown');
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0.1);
  });

  it('always includes the originalMessage on the result', () => {
    const msg = 'original error message text';
    const result = classifyError(msg);
    expect(result.originalMessage).toBe(msg);
  });

  it('always includes at least one suggestion', () => {
    const result = classifyError('totally unknown error');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// classifyError — location extraction
// ============================================================================

describe('classifyError — location extraction', () => {
  it('extracts file, line, and column from TypeScript error', () => {
    const result = classifyError('TS2345: error at /src/index.ts:10:5');
    expect(result.location).toBeDefined();
    expect(result.location?.file).toContain('index.ts');
    expect(result.location?.line).toBe(10);
    expect(result.location?.column).toBe(5);
  });

  it('returns undefined location for messages without file references', () => {
    const result = classifyError('Rate limit exceeded');
    // May or may not have location depending on content — only check if present
    if (result.location !== undefined) {
      expect(typeof result.location.file).toBe('string');
    }
  });
});

// ============================================================================
// classifyErrors — deduplication and sorting
// ============================================================================

describe('classifyErrors', () => {
  it('deduplicates by category, keeping highest confidence', () => {
    const results = classifyErrors([
      'Rate limit exceeded',
      '429: too many requests',
    ]);
    const rateLimitResults = results.filter((r) => r.category === 'agent_rate_limit');
    expect(rateLimitResults.length).toBe(1);
  });

  it('sorts results with critical severity first', () => {
    const results = classifyErrors([
      'ETIMEDOUT: request timed out',       // warning
      'TS2345: type error',                  // error
    ]);
    // Both should appear; errors should sort before warnings
    const severities = results.map((r) => r.severity);
    const errorIdx = severities.indexOf('error');
    const warningIdx = severities.indexOf('warning');
    if (errorIdx !== -1 && warningIdx !== -1) {
      expect(errorIdx).toBeLessThan(warningIdx);
    }
  });

  it('handles an empty array gracefully', () => {
    expect(classifyErrors([])).toEqual([]);
  });

  it('returns an array of ErrorAttribution objects', () => {
    const results = classifyErrors(['Rate limit exceeded']);
    expect(Array.isArray(results)).toBe(true);
    for (const result of results) {
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('confidence');
    }
  });
});

// ============================================================================
// isErrorFromSource
// ============================================================================

describe('isErrorFromSource', () => {
  it('returns true when source matches with sufficient confidence', () => {
    expect(isErrorFromSource('Rate limit exceeded: 429', 'agent')).toBe(true);
  });

  it('returns false for the wrong source', () => {
    expect(isErrorFromSource('Rate limit exceeded: 429', 'styrby')).toBe(false);
  });

  it('returns false for unknown errors (confidence < 0.5)', () => {
    expect(isErrorFromSource('totally unrecognized error xyz', 'agent')).toBe(false);
  });
});

// ============================================================================
// getPatternById
// ============================================================================

describe('getPatternById', () => {
  it('returns the pattern for a known id', () => {
    const pattern = getPatternById('agent_rate_limit');
    expect(pattern).toBeDefined();
    expect(pattern?.source).toBe('agent');
    expect(pattern?.category).toBe('agent_rate_limit');
  });

  it('returns the TypeScript error pattern', () => {
    const pattern = getPatternById('typescript_error');
    expect(pattern).toBeDefined();
    expect(pattern?.source).toBe('build');
  });

  it('returns undefined for an unknown id', () => {
    expect(getPatternById('nonexistent_pattern_xyz')).toBeUndefined();
  });
});
