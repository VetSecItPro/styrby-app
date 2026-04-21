/**
 * Tests for API key utilities (utils/api-keys.ts).
 *
 * Covers: generateRandomString, generateApiKey, extractApiKeyPrefix,
 * isValidApiKeyFormat, maskApiKey.
 *
 * @module utils/__tests__/api-keys
 */

import { describe, it, expect } from 'vitest';
import {
  generateRandomString,
  generateApiKey,
  extractApiKeyPrefix,
  isValidApiKeyFormat,
  maskApiKey,
  API_KEY_PREFIX,
  API_KEY_RANDOM_LENGTH,
} from '../api-keys.js';

// ============================================================================
// generateRandomString
// ============================================================================

describe('generateRandomString', () => {
  it('returns a string of the exact requested length', () => {
    expect(generateRandomString(10).length).toBe(10);
    expect(generateRandomString(32).length).toBe(32);
    expect(generateRandomString(1).length).toBe(1);
  });

  it('only contains characters from the allowed alphabet (no ambiguous chars)', () => {
    // WHY: The alphabet excludes 0, O, l, 1 for readability.
    const ambiguous = new Set(['0', 'O', 'l', '1']);
    const result = generateRandomString(200);
    for (const ch of result) {
      expect(ambiguous.has(ch), `character "${ch}" should not be in output`).toBe(false);
    }
  });

  it('produces alphanumeric output only', () => {
    const result = generateRandomString(100);
    expect(result).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it('produces different values on successive calls (entropy)', () => {
    const a = generateRandomString(32);
    const b = generateRandomString(32);
    // Probability of collision is astronomically low (~2^-186)
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// generateApiKey
// ============================================================================

describe('generateApiKey', () => {
  it('returns an object with key, prefix, and randomPart', () => {
    const result = generateApiKey();
    expect(result).toHaveProperty('key');
    expect(result).toHaveProperty('prefix');
    expect(result).toHaveProperty('randomPart');
  });

  it('key starts with the API_KEY_PREFIX', () => {
    const { key } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it('prefix equals API_KEY_PREFIX constant', () => {
    const { prefix } = generateApiKey();
    expect(prefix).toBe(API_KEY_PREFIX);
  });

  it('randomPart has the correct length', () => {
    const { randomPart } = generateApiKey();
    expect(randomPart.length).toBe(API_KEY_RANDOM_LENGTH);
  });

  it('key is prefix + randomPart concatenated', () => {
    const { key, prefix, randomPart } = generateApiKey();
    expect(key).toBe(`${prefix}${randomPart}`);
  });

  it('key is valid format (passes isValidApiKeyFormat)', () => {
    const { key } = generateApiKey();
    expect(isValidApiKeyFormat(key)).toBe(true);
  });

  it('produces unique keys on each call', () => {
    const a = generateApiKey().key;
    const b = generateApiKey().key;
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// extractApiKeyPrefix
// ============================================================================

describe('extractApiKeyPrefix', () => {
  it('returns the prefix for a valid Styrby key', () => {
    const { key } = generateApiKey();
    expect(extractApiKeyPrefix(key)).toBe(API_KEY_PREFIX);
  });

  it('returns null for a key with an unknown prefix', () => {
    expect(extractApiKeyPrefix('invalid_abc123')).toBeNull();
    expect(extractApiKeyPrefix('sk_live_somekey')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractApiKeyPrefix('')).toBeNull();
  });

  it('returns null for non-string values', () => {
    // @ts-expect-error — intentional invalid input test
    expect(extractApiKeyPrefix(null)).toBeNull();
    // @ts-expect-error
    expect(extractApiKeyPrefix(undefined)).toBeNull();
  });
});

// ============================================================================
// isValidApiKeyFormat
// ============================================================================

describe('isValidApiKeyFormat', () => {
  it('accepts a freshly generated key', () => {
    expect(isValidApiKeyFormat(generateApiKey().key)).toBe(true);
  });

  it('rejects a key with wrong prefix', () => {
    expect(isValidApiKeyFormat('wrong_' + 'a'.repeat(API_KEY_RANDOM_LENGTH))).toBe(false);
  });

  it('rejects a key that is too short', () => {
    expect(isValidApiKeyFormat(`${API_KEY_PREFIX}short`)).toBe(false);
  });

  it('rejects a key that is too long', () => {
    expect(isValidApiKeyFormat(`${API_KEY_PREFIX}${'a'.repeat(API_KEY_RANDOM_LENGTH + 1)}`)).toBe(false);
  });

  it('rejects a key with non-alphanumeric characters in the random part', () => {
    const badRandomPart = '-'.repeat(API_KEY_RANDOM_LENGTH);
    expect(isValidApiKeyFormat(`${API_KEY_PREFIX}${badRandomPart}`)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidApiKeyFormat('')).toBe(false);
  });

  it('rejects non-string values', () => {
    // @ts-expect-error — intentional invalid input test
    expect(isValidApiKeyFormat(null)).toBe(false);
    // @ts-expect-error
    expect(isValidApiKeyFormat(42)).toBe(false);
  });
});

// ============================================================================
// maskApiKey
// ============================================================================

describe('maskApiKey', () => {
  it('shows prefix + first 4 + ... + last 4 chars of random part', () => {
    const { key, randomPart } = generateApiKey();
    const masked = maskApiKey(key);
    expect(masked).toContain(API_KEY_PREFIX);
    expect(masked).toContain(randomPart.slice(0, 4));
    expect(masked).toContain(randomPart.slice(-4));
    expect(masked).toContain('...');
  });

  it('does not reveal the full key', () => {
    const { key } = generateApiKey();
    const masked = maskApiKey(key);
    expect(masked).not.toBe(key);
    // The full 32-char random part should not appear intact
    const randomPart = key.slice(API_KEY_PREFIX.length);
    expect(masked).not.toContain(randomPart);
  });

  it('returns empty string for empty input', () => {
    expect(maskApiKey('')).toBe('');
  });

  it('handles non-string gracefully by returning empty string', () => {
    // @ts-expect-error — intentional invalid input test
    expect(maskApiKey(null)).toBe('');
  });

  it('falls back gracefully for unknown prefix: short keys (<=8 chars) return ********', () => {
    // Source: keys <= 8 chars → '********'
    expect(maskApiKey('short')).toBe('********');
    expect(maskApiKey('12345678')).toBe('********');
  });

  it('falls back gracefully for unknown prefix: longer keys show first+last 4 chars', () => {
    // Source: keys > 8 chars without a known prefix → first4...last4
    expect(maskApiKey('123456789abc')).toBe('1234...9abc');
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('API key constants', () => {
  it('API_KEY_PREFIX is styrby_', () => {
    expect(API_KEY_PREFIX).toBe('styrby_');
  });

  it('API_KEY_RANDOM_LENGTH is 32', () => {
    expect(API_KEY_RANDOM_LENGTH).toBe(32);
  });
});
