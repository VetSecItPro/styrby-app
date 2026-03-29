/**
 * Tests for the Error Classifier
 *
 * Validates that classifyError correctly identifies error sources, categories,
 * confidence levels, severity, and location extraction for all supported pattern
 * groups: Styrby, Agent, Build, and Network.
 *
 * Also tests classifyErrors (batch deduplication + severity sort) and
 * the helper functions isErrorFromSource / getPatternById.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  classifyErrors,
  isErrorFromSource,
  getPatternById,
} from '../../src/errors/classifier';

// =============================================================================
// classifyError() — unknown / unmatched
// =============================================================================

describe('classifyError()', () => {
  describe('unknown / unmatched messages', () => {
    it('returns source "unknown" when no pattern matches', () => {
      const result = classifyError('something completely unrecognisable xyz123');
      expect(result.source).toBe('unknown');
    });

    it('returns category "unknown" when no pattern matches', () => {
      const result = classifyError('something completely unrecognisable xyz123');
      expect(result.category).toBe('unknown');
    });

    it('returns a low confidence score for unknown errors', () => {
      const result = classifyError('something completely unrecognisable xyz123');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('preserves the originalMessage', () => {
      const msg = 'totally unknown error';
      const result = classifyError(msg);
      expect(result.originalMessage).toBe(msg);
    });

    it('returns at least one suggestion for unknown errors', () => {
      const result = classifyError('something completely unrecognisable xyz123');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('returns severity "error" for unknown errors', () => {
      const result = classifyError('something completely unrecognisable xyz123');
      expect(result.severity).toBe('error');
    });
  });

  // ===========================================================================
  // Styrby patterns
  // ===========================================================================

  describe('Styrby error patterns', () => {
    it('classifies relay connection failures as source "styrby"', () => {
      const result = classifyError('failed to connect to relay server');
      expect(result.source).toBe('styrby');
    });

    it('classifies relay connection failures with category "relay_connection"', () => {
      const result = classifyError('failed to connect to relay server');
      expect(result.category).toBe('relay_connection');
    });

    it('classifies relay connection failures with severity "error"', () => {
      const result = classifyError('relay connection failed: ECONNREFUSED');
      expect(result.severity).toBe('error');
    });

    it('classifies WebSocket connection failures as relay_connection', () => {
      const result = classifyError('websocket connection failed to styrby relay');
      expect(result.source).toBe('styrby');
      expect(result.category).toBe('relay_connection');
    });

    it('classifies auth expired errors as source "styrby"', () => {
      const result = classifyError('token expired, please re-authenticate');
      expect(result.source).toBe('styrby');
    });

    it('classifies auth expired errors with category "auth_expired"', () => {
      const result = classifyError('token expired, please re-authenticate');
      expect(result.category).toBe('auth_expired');
    });

    it('classifies auth expired errors with severity "warning"', () => {
      const result = classifyError('session expired after idle timeout');
      expect(result.severity).toBe('warning');
    });

    it('classifies refresh token invalid as auth_expired', () => {
      const result = classifyError('refresh token invalid or expired');
      expect(result.source).toBe('styrby');
      expect(result.category).toBe('auth_expired');
    });

    it('provides a suggestion with action for relay connection errors', () => {
      const result = classifyError('failed to connect to relay server');
      const hasAction = result.suggestions.some((s) => s.autoFixable && s.action);
      expect(hasAction).toBe(true);
    });

    it('provides a suggestion with action for auth expired errors', () => {
      const result = classifyError('token expired, please re-authenticate');
      const hasAction = result.suggestions.some((s) => s.autoFixable && s.action);
      expect(hasAction).toBe(true);
    });

    it('returns confidence >= 0.7 for Styrby relay errors', () => {
      const result = classifyError('failed to connect to relay server');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  // ===========================================================================
  // Agent patterns
  // ===========================================================================

  describe('Agent error patterns', () => {
    it('classifies rate limit errors as source "agent"', () => {
      const result = classifyError('rate limit exceeded, please wait');
      expect(result.source).toBe('agent');
    });

    it('classifies rate limit errors with category "agent_rate_limit"', () => {
      const result = classifyError('rate limit exceeded, please wait');
      expect(result.category).toBe('agent_rate_limit');
    });

    it('classifies 429 HTTP status as agent_rate_limit', () => {
      const result = classifyError('Request failed with status code 429');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_rate_limit');
    });

    it('classifies "too many requests" as agent_rate_limit', () => {
      const result = classifyError('too many requests — please slow down');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_rate_limit');
    });

    it('classifies rate limit errors with severity "warning"', () => {
      const result = classifyError('rate limit exceeded, please wait');
      expect(result.severity).toBe('warning');
    });

    it('classifies context length exceeded as "agent_context_limit"', () => {
      const result = classifyError('context length exceeded the maximum tokens allowed');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_context_limit');
    });

    it('classifies context window full as agent_context_limit', () => {
      const result = classifyError('context window full — start a new session');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_context_limit');
    });

    it('classifies context limit errors with severity "warning"', () => {
      const result = classifyError('context length exceeded the maximum tokens allowed');
      expect(result.severity).toBe('warning');
    });

    it('classifies Anthropic API errors as "agent_api_error"', () => {
      const result = classifyError('Anthropic API error: 500 Internal Server Error');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_api_error');
    });

    it('classifies OpenAI API errors as "agent_api_error"', () => {
      const result = classifyError('OpenAI API error: service unavailable');
      expect(result.source).toBe('agent');
      expect(result.category).toBe('agent_api_error');
    });

    it('classifies agent API errors with severity "error"', () => {
      const result = classifyError('Anthropic API error: 500 Internal Server Error');
      expect(result.severity).toBe('error');
    });

    it('provides a suggestion with action for context limit errors', () => {
      const result = classifyError('context length exceeded the maximum tokens allowed');
      const hasAction = result.suggestions.some((s) => s.autoFixable && s.action);
      expect(hasAction).toBe(true);
    });
  });

  // ===========================================================================
  // Build patterns
  // ===========================================================================

  describe('Build error patterns', () => {
    it('classifies TypeScript errors (TS code) as source "build"', () => {
      const result = classifyError('TS2345: Argument of type string is not assignable to number');
      expect(result.source).toBe('build');
    });

    it('classifies TypeScript errors with category "build_type"', () => {
      const result = classifyError('TS2345: Argument of type string is not assignable to number');
      expect(result.category).toBe('build_type');
    });

    it('classifies TypeScript errors with severity "error"', () => {
      const result = classifyError('TS2345: Argument of type string is not assignable to number');
      expect(result.severity).toBe('error');
    });

    it('classifies "type is not assignable" as build_type', () => {
      const result = classifyError('type string is not assignable to type number');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_type');
    });

    it('classifies "property does not exist" as build_type', () => {
      const result = classifyError('property "foo" does not exist on type "Bar"');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_type');
    });

    it('classifies "cannot find module" as build_type', () => {
      const result = classifyError('cannot find module "@styrby/shared" or its type declarations');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_type');
    });

    it('extracts TS error code into details', () => {
      const result = classifyError('TS2322: type "string" is not assignable');
      expect(result.details).toBeDefined();
      expect(result.details?.errorCode).toBe('TS2322');
    });

    it('classifies ESLint parsing errors as build_syntax', () => {
      const result = classifyError('ESLint error: parsing error on line 5');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_syntax');
    });

    it('classifies npm ERESOLVE as build_dependency', () => {
      const result = classifyError('npm ERR! code ERESOLVE peer dep conflict');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_dependency');
    });

    it('classifies "module not found" as build_dependency', () => {
      const result = classifyError('Module not found: cannot resolve "@foo/bar"');
      expect(result.source).toBe('build');
      expect(result.category).toBe('build_dependency');
    });

    it('classifies build_dependency errors with severity "error"', () => {
      const result = classifyError('npm ERR! code ERESOLVE peer dep conflict');
      expect(result.severity).toBe('error');
    });

    it('classifies test failures as source "build"', () => {
      const result = classifyError('FAIL src/utils/api-keys.test.ts — 2 failed');
      expect(result.source).toBe('build');
    });

    it('classifies test failures with category "test_failure"', () => {
      const result = classifyError('FAIL src/utils/api-keys.test.ts — 2 failed');
      expect(result.category).toBe('test_failure');
    });

    it('classifies AssertionError as test_failure', () => {
      const result = classifyError('AssertionError: expected "foo" to equal "bar"');
      expect(result.source).toBe('build');
      expect(result.category).toBe('test_failure');
    });
  });

  // ===========================================================================
  // Network patterns
  // ===========================================================================

  describe('Network error patterns', () => {
    it('classifies ERR_INTERNET_DISCONNECTED as source "network"', () => {
      const result = classifyError('net::ERR_INTERNET_DISCONNECTED');
      expect(result.source).toBe('network');
    });

    it('classifies ERR_INTERNET_DISCONNECTED with category "network_offline"', () => {
      const result = classifyError('net::ERR_INTERNET_DISCONNECTED');
      expect(result.category).toBe('network_offline');
    });

    it('classifies "network offline" as network_offline', () => {
      const result = classifyError('network offline — cannot reach server');
      expect(result.source).toBe('network');
      expect(result.category).toBe('network_offline');
    });

    it('classifies ETIMEDOUT as network_timeout', () => {
      const result = classifyError('connect ETIMEDOUT 192.168.1.1:443');
      expect(result.source).toBe('network');
      expect(result.category).toBe('network_timeout');
    });

    it('classifies ECONNRESET as network_timeout', () => {
      const result = classifyError('read ECONNRESET socket hang up');
      expect(result.source).toBe('network');
      expect(result.category).toBe('network_timeout');
    });

    it('classifies network_timeout with severity "warning"', () => {
      const result = classifyError('request timed out after 30000ms');
      expect(result.severity).toBe('warning');
    });

    it('classifies ENOTFOUND as network_dns', () => {
      const result = classifyError('getaddrinfo ENOTFOUND api.anthropic.com');
      expect(result.source).toBe('network');
      expect(result.category).toBe('network_dns');
    });

    it('classifies DNS failed as network_dns', () => {
      const result = classifyError('DNS failed: unable to resolve hostname');
      expect(result.source).toBe('network');
      expect(result.category).toBe('network_dns');
    });

    it('classifies network_dns with severity "error"', () => {
      const result = classifyError('getaddrinfo ENOTFOUND api.anthropic.com');
      expect(result.severity).toBe('error');
    });
  });

  // ===========================================================================
  // Location extraction
  // ===========================================================================

  describe('location extraction', () => {
    it('extracts file, line, and column from TypeScript-style path', () => {
      const result = classifyError('TS2345: error at /src/utils/foo.ts:10:5');
      expect(result.location?.file).toContain('foo.ts');
      expect(result.location?.line).toBe(10);
      expect(result.location?.column).toBe(5);
    });

    it('extracts file and line when column is absent', () => {
      const result = classifyError('error at /src/bar.ts:42');
      expect(result.location?.file).toContain('bar.ts');
      expect(result.location?.line).toBe(42);
      expect(result.location?.column).toBeUndefined();
    });

    it('returns undefined location when no file path is present', () => {
      const result = classifyError('rate limit exceeded');
      expect(result.location).toBeUndefined();
    });
  });

  // ===========================================================================
  // Structure guarantees
  // ===========================================================================

  describe('result structure', () => {
    it('always returns the required ErrorAttribution fields', () => {
      const result = classifyError('some error message');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('severity');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('suggestions');
      expect(result).toHaveProperty('originalMessage');
    });

    it('confidence is always between 0 and 1', () => {
      const messages = [
        'rate limit exceeded',
        'TS2345: type error',
        'totally random string 8x9z',
        'token expired',
        'getaddrinfo ENOTFOUND foo.com',
      ];
      for (const msg of messages) {
        const { confidence } = classifyError(msg);
        expect(confidence).toBeGreaterThanOrEqual(0);
        expect(confidence).toBeLessThanOrEqual(1);
      }
    });

    it('suggestions is always an array', () => {
      const result = classifyError('anything');
      expect(Array.isArray(result.suggestions)).toBe(true);
    });
  });
});

// =============================================================================
// classifyErrors() — batch + deduplication
// =============================================================================

describe('classifyErrors()', () => {
  it('returns an array of ErrorAttribution objects', () => {
    const results = classifyErrors(['rate limit exceeded', 'token expired']);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates messages with the same category, keeping highest confidence', () => {
    // Both messages match agent_rate_limit
    const results = classifyErrors([
      'rate limit exceeded',
      'too many requests — throttle limit hit',
    ]);
    const rateLimitEntries = results.filter((r) => r.category === 'agent_rate_limit');
    expect(rateLimitEntries.length).toBe(1);
  });

  it('returns distinct categories when messages differ', () => {
    const results = classifyErrors([
      'rate limit exceeded',
      'token expired',
      'getaddrinfo ENOTFOUND foo.com',
    ]);
    const categories = results.map((r) => r.category);
    const unique = new Set(categories);
    expect(unique.size).toBe(categories.length);
  });

  it('sorts results so critical/error precedes warning/info', () => {
    const results = classifyErrors([
      'rate limit exceeded',           // warning
      'getaddrinfo ENOTFOUND foo.com', // error
    ]);
    const severities = results.map((r) => r.severity);
    const order = { critical: 0, error: 1, warning: 2, info: 3 };
    for (let i = 0; i < severities.length - 1; i++) {
      expect(order[severities[i]]).toBeLessThanOrEqual(order[severities[i + 1]]);
    }
  });

  it('handles an empty array gracefully', () => {
    const results = classifyErrors([]);
    expect(results).toEqual([]);
  });

  it('handles a single-element array', () => {
    const results = classifyErrors(['rate limit exceeded']);
    expect(results.length).toBe(1);
    expect(results[0].category).toBe('agent_rate_limit');
  });
});

// =============================================================================
// isErrorFromSource()
// =============================================================================

describe('isErrorFromSource()', () => {
  it('returns true when message matches the given source with high confidence', () => {
    expect(isErrorFromSource('rate limit exceeded', 'agent')).toBe(true);
  });

  it('returns false when message does not match the given source', () => {
    expect(isErrorFromSource('rate limit exceeded', 'network')).toBe(false);
  });

  it('returns false for unknown errors regardless of source', () => {
    expect(isErrorFromSource('totally unknown xyz123', 'styrby')).toBe(false);
  });

  it('correctly identifies a Styrby auth error as "styrby" source', () => {
    expect(isErrorFromSource('token expired please re-authenticate', 'styrby')).toBe(true);
  });

  it('returns false when source matches but confidence is below threshold', () => {
    // An unknown message has confidence 0.1, below the 0.5 threshold
    expect(isErrorFromSource('totally unknown xyz123', 'unknown')).toBe(false);
  });
});

// =============================================================================
// getPatternById()
// =============================================================================

describe('getPatternById()', () => {
  it('returns a pattern for a known ID', () => {
    const pattern = getPatternById('relay_connection_failed');
    expect(pattern).toBeDefined();
    expect(pattern?.id).toBe('relay_connection_failed');
  });

  it('returns the correct source for a known pattern', () => {
    const pattern = getPatternById('relay_connection_failed');
    expect(pattern?.source).toBe('styrby');
  });

  it('returns undefined for an unknown ID', () => {
    const pattern = getPatternById('this_does_not_exist');
    expect(pattern).toBeUndefined();
  });

  it('returns the agent_rate_limit pattern', () => {
    const pattern = getPatternById('agent_rate_limit');
    expect(pattern?.source).toBe('agent');
    expect(pattern?.category).toBe('agent_rate_limit');
  });

  it('returns the typescript_error pattern', () => {
    const pattern = getPatternById('typescript_error');
    expect(pattern?.source).toBe('build');
    expect(pattern?.category).toBe('build_type');
  });

  it('returns the network_dns pattern', () => {
    const pattern = getPatternById('network_dns');
    expect(pattern?.source).toBe('network');
    expect(pattern?.category).toBe('network_dns');
  });
});
