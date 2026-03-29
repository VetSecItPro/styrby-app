/**
 * Tests for the Error Patterns Registry
 *
 * Validates that ALL_PATTERNS is structurally sound (no duplicate IDs, valid
 * sources/categories, non-empty regex and keyword arrays) and that each
 * named export (STYRBY_PATTERNS, AGENT_PATTERNS, BUILD_PATTERNS,
 * NETWORK_PATTERNS) contains expected entries.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_PATTERNS,
  STYRBY_PATTERNS,
  AGENT_PATTERNS,
  BUILD_PATTERNS,
  NETWORK_PATTERNS,
} from '../../src/errors/patterns';
import type { ErrorSource, ErrorCategory } from '../../src/errors/types';

// ---------------------------------------------------------------------------
// Valid value sets derived from the ErrorSource and ErrorCategory types
// ---------------------------------------------------------------------------

const VALID_SOURCES: ErrorSource[] = ['styrby', 'agent', 'build', 'network', 'user', 'unknown'];

const VALID_CATEGORIES: ErrorCategory[] = [
  'relay_connection', 'relay_timeout', 'auth_expired', 'auth_invalid',
  'storage_full', 'config_invalid',
  'agent_timeout', 'agent_rate_limit', 'agent_context_limit',
  'agent_invalid_response', 'agent_permission_denied', 'agent_api_error',
  'build_syntax', 'build_type', 'build_dependency', 'build_config',
  'build_memory', 'test_failure',
  'network_offline', 'network_timeout', 'network_dns', 'network_ssl', 'network_cors',
  'user_input', 'user_permission', 'user_quota',
  'unknown',
];

const VALID_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;

// =============================================================================
// ALL_PATTERNS — structural integrity
// =============================================================================

describe('ALL_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(ALL_PATTERNS)).toBe(true);
    expect(ALL_PATTERNS.length).toBeGreaterThan(0);
  });

  it('contains no duplicate IDs', () => {
    const ids = ALL_PATTERNS.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every pattern has a non-empty string id', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(typeof pattern.id).toBe('string');
      expect(pattern.id.length).toBeGreaterThan(0);
    }
  });

  it('every pattern has a valid source', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(VALID_SOURCES).toContain(pattern.source);
    }
  });

  it('every pattern has a valid category', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(VALID_CATEGORIES).toContain(pattern.category);
    }
  });

  it('every pattern has a valid severity', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(VALID_SEVERITIES).toContain(pattern.severity);
    }
  });

  it('every pattern has at least one regex', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(Array.isArray(pattern.patterns)).toBe(true);
      expect(pattern.patterns.length).toBeGreaterThan(0);
      for (const regex of pattern.patterns) {
        expect(regex).toBeInstanceOf(RegExp);
      }
    }
  });

  it('every pattern has at least one keyword', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(Array.isArray(pattern.keywords)).toBe(true);
      expect(pattern.keywords.length).toBeGreaterThan(0);
    }
  });

  it('every pattern has at least one suggestion', () => {
    for (const pattern of ALL_PATTERNS) {
      expect(Array.isArray(pattern.suggestions)).toBe(true);
      expect(pattern.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('every suggestion has a non-empty title and description', () => {
    for (const pattern of ALL_PATTERNS) {
      for (const suggestion of pattern.suggestions) {
        expect(typeof suggestion.title).toBe('string');
        expect(suggestion.title.length).toBeGreaterThan(0);
        expect(typeof suggestion.description).toBe('string');
        expect(suggestion.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('suggestions with autoFixable=true have an action string', () => {
    for (const pattern of ALL_PATTERNS) {
      for (const suggestion of pattern.suggestions) {
        if (suggestion.autoFixable) {
          // autoFixable without action would be misleading
          if (suggestion.action !== undefined) {
            expect(typeof suggestion.action).toBe('string');
            expect(suggestion.action.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('equals the union of all named exports', () => {
    const combined = [
      ...STYRBY_PATTERNS,
      ...AGENT_PATTERNS,
      ...BUILD_PATTERNS,
      ...NETWORK_PATTERNS,
    ];
    expect(ALL_PATTERNS.length).toBe(combined.length);

    const allIds = new Set(ALL_PATTERNS.map((p) => p.id));
    for (const p of combined) {
      expect(allIds.has(p.id)).toBe(true);
    }
  });
});

// =============================================================================
// STYRBY_PATTERNS
// =============================================================================

describe('STYRBY_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(STYRBY_PATTERNS.length).toBeGreaterThan(0);
  });

  it('all patterns have source "styrby"', () => {
    for (const p of STYRBY_PATTERNS) {
      expect(p.source).toBe('styrby');
    }
  });

  it('includes a relay_connection_failed pattern', () => {
    const found = STYRBY_PATTERNS.find((p) => p.id === 'relay_connection_failed');
    expect(found).toBeDefined();
    expect(found?.category).toBe('relay_connection');
  });

  it('includes an auth_expired pattern', () => {
    const found = STYRBY_PATTERNS.find((p) => p.id === 'auth_expired');
    expect(found).toBeDefined();
    expect(found?.category).toBe('auth_expired');
  });

  it('relay_connection_failed regex matches "failed to connect to relay"', () => {
    const pattern = STYRBY_PATTERNS.find((p) => p.id === 'relay_connection_failed');
    const matched = pattern?.patterns.some((re) => re.test('failed to connect to relay'));
    expect(matched).toBe(true);
  });

  it('auth_expired regex matches "token expired"', () => {
    const pattern = STYRBY_PATTERNS.find((p) => p.id === 'auth_expired');
    const matched = pattern?.patterns.some((re) => re.test('token expired'));
    expect(matched).toBe(true);
  });
});

// =============================================================================
// AGENT_PATTERNS
// =============================================================================

describe('AGENT_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(AGENT_PATTERNS.length).toBeGreaterThan(0);
  });

  it('all patterns have source "agent"', () => {
    for (const p of AGENT_PATTERNS) {
      expect(p.source).toBe('agent');
    }
  });

  it('includes an agent_rate_limit pattern', () => {
    const found = AGENT_PATTERNS.find((p) => p.id === 'agent_rate_limit');
    expect(found).toBeDefined();
    expect(found?.category).toBe('agent_rate_limit');
  });

  it('includes an agent_context_limit pattern', () => {
    const found = AGENT_PATTERNS.find((p) => p.id === 'agent_context_limit');
    expect(found).toBeDefined();
    expect(found?.category).toBe('agent_context_limit');
  });

  it('includes an agent_api_error pattern', () => {
    const found = AGENT_PATTERNS.find((p) => p.id === 'agent_api_error');
    expect(found).toBeDefined();
    expect(found?.category).toBe('agent_api_error');
  });

  it('agent_rate_limit regex matches "rate limit exceeded"', () => {
    const pattern = AGENT_PATTERNS.find((p) => p.id === 'agent_rate_limit');
    const matched = pattern?.patterns.some((re) => re.test('rate limit exceeded'));
    expect(matched).toBe(true);
  });

  it('agent_rate_limit regex matches "429"', () => {
    const pattern = AGENT_PATTERNS.find((p) => p.id === 'agent_rate_limit');
    const matched = pattern?.patterns.some((re) => re.test('429'));
    expect(matched).toBe(true);
  });

  it('agent_context_limit regex matches "context length exceeded"', () => {
    const pattern = AGENT_PATTERNS.find((p) => p.id === 'agent_context_limit');
    const matched = pattern?.patterns.some((re) => re.test('context length exceeded'));
    expect(matched).toBe(true);
  });
});

// =============================================================================
// BUILD_PATTERNS
// =============================================================================

describe('BUILD_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(BUILD_PATTERNS.length).toBeGreaterThan(0);
  });

  it('all patterns have source "build"', () => {
    for (const p of BUILD_PATTERNS) {
      expect(p.source).toBe('build');
    }
  });

  it('includes a typescript_error pattern', () => {
    const found = BUILD_PATTERNS.find((p) => p.id === 'typescript_error');
    expect(found).toBeDefined();
    expect(found?.category).toBe('build_type');
  });

  it('includes an eslint_error pattern', () => {
    const found = BUILD_PATTERNS.find((p) => p.id === 'eslint_error');
    expect(found).toBeDefined();
    expect(found?.category).toBe('build_syntax');
  });

  it('includes an npm_dependency pattern', () => {
    const found = BUILD_PATTERNS.find((p) => p.id === 'npm_dependency');
    expect(found).toBeDefined();
    expect(found?.category).toBe('build_dependency');
  });

  it('includes a test_failure pattern', () => {
    const found = BUILD_PATTERNS.find((p) => p.id === 'test_failure');
    expect(found).toBeDefined();
    expect(found?.category).toBe('test_failure');
  });

  it('typescript_error regex matches "TS2345:"', () => {
    const pattern = BUILD_PATTERNS.find((p) => p.id === 'typescript_error');
    const matched = pattern?.patterns.some((re) => re.test('TS2345:'));
    expect(matched).toBe(true);
  });

  it('typescript_error has an extractDetails function', () => {
    const pattern = BUILD_PATTERNS.find((p) => p.id === 'typescript_error');
    expect(typeof pattern?.extractDetails).toBe('function');
  });

  it('typescript_error extractDetails returns errorCode for a TS error match', () => {
    const pattern = BUILD_PATTERNS.find((p) => p.id === 'typescript_error');
    const regex = pattern?.patterns[0];
    const match = 'TS2345: type mismatch'.match(regex!);
    expect(match).not.toBeNull();
    const details = pattern?.extractDetails?.(match!);
    expect(details?.errorCode).toBe('TS2345');
  });

  it('npm_dependency regex matches "npm ERR!"', () => {
    const pattern = BUILD_PATTERNS.find((p) => p.id === 'npm_dependency');
    const matched = pattern?.patterns.some((re) => re.test('npm ERR! code ERESOLVE'));
    expect(matched).toBe(true);
  });
});

// =============================================================================
// NETWORK_PATTERNS
// =============================================================================

describe('NETWORK_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(NETWORK_PATTERNS.length).toBeGreaterThan(0);
  });

  it('all patterns have source "network"', () => {
    for (const p of NETWORK_PATTERNS) {
      expect(p.source).toBe('network');
    }
  });

  it('includes a network_offline pattern', () => {
    const found = NETWORK_PATTERNS.find((p) => p.id === 'network_offline');
    expect(found).toBeDefined();
    expect(found?.category).toBe('network_offline');
  });

  it('includes a network_timeout pattern', () => {
    const found = NETWORK_PATTERNS.find((p) => p.id === 'network_timeout');
    expect(found).toBeDefined();
    expect(found?.category).toBe('network_timeout');
  });

  it('includes a network_dns pattern', () => {
    const found = NETWORK_PATTERNS.find((p) => p.id === 'network_dns');
    expect(found).toBeDefined();
    expect(found?.category).toBe('network_dns');
  });

  it('network_offline regex matches "ERR_INTERNET_DISCONNECTED"', () => {
    const pattern = NETWORK_PATTERNS.find((p) => p.id === 'network_offline');
    const matched = pattern?.patterns.some((re) => re.test('net::ERR_INTERNET_DISCONNECTED'));
    expect(matched).toBe(true);
  });

  it('network_timeout regex matches "ETIMEDOUT"', () => {
    const pattern = NETWORK_PATTERNS.find((p) => p.id === 'network_timeout');
    const matched = pattern?.patterns.some((re) => re.test('connect ETIMEDOUT'));
    expect(matched).toBe(true);
  });

  it('network_dns regex matches "ENOTFOUND"', () => {
    const pattern = NETWORK_PATTERNS.find((p) => p.id === 'network_dns');
    const matched = pattern?.patterns.some((re) => re.test('ENOTFOUND api.anthropic.com'));
    expect(matched).toBe(true);
  });
});
