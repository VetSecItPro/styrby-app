/**
 * Tests for the API Key Generation Utilities
 *
 * Validates API key generation, formatting, validation, prefix extraction,
 * and masking for Styrby's Power tier API access feature.
 *
 * Key format: "styrby_" + 32 random alphanumeric characters
 */

import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  generateRandomString,
  extractApiKeyPrefix,
  isValidApiKeyFormat,
  maskApiKey,
  API_KEY_PREFIX,
  API_KEY_RANDOM_LENGTH,
} from '../../src/utils/api-keys';

describe('API Key Utilities', () => {
  // ==========================================================================
  // generateApiKey()
  // ==========================================================================

  describe('generateApiKey()', () => {
    it('returns an object with key, prefix, and randomPart', () => {
      const result = generateApiKey();
      expect(result).toHaveProperty('key');
      expect(result).toHaveProperty('prefix');
      expect(result).toHaveProperty('randomPart');
    });

    it('returns a key that starts with the styrby_ prefix', () => {
      const result = generateApiKey();
      expect(result.key.startsWith('styrby_')).toBe(true);
    });

    it('returns the correct prefix value', () => {
      const result = generateApiKey();
      expect(result.prefix).toBe('styrby_');
      expect(result.prefix).toBe(API_KEY_PREFIX);
    });

    it('returns a randomPart of 32 characters', () => {
      const result = generateApiKey();
      expect(result.randomPart.length).toBe(32);
      expect(result.randomPart.length).toBe(API_KEY_RANDOM_LENGTH);
    });

    it('returns a key whose length is prefix + random part', () => {
      const result = generateApiKey();
      expect(result.key.length).toBe(API_KEY_PREFIX.length + API_KEY_RANDOM_LENGTH);
    });

    it('returns a key composed of prefix + randomPart', () => {
      const result = generateApiKey();
      expect(result.key).toBe(`${result.prefix}${result.randomPart}`);
    });

    it('generates unique keys on each call', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.key).not.toBe(key2.key);
      expect(key1.randomPart).not.toBe(key2.randomPart);
    });
  });

  // ==========================================================================
  // generateRandomString()
  // ==========================================================================

  describe('generateRandomString()', () => {
    it('returns a string of the requested length', () => {
      expect(generateRandomString(10).length).toBe(10);
      expect(generateRandomString(32).length).toBe(32);
      expect(generateRandomString(64).length).toBe(64);
    });

    it('returns an empty string for length 0', () => {
      expect(generateRandomString(0)).toBe('');
    });

    it('returns only alphanumeric characters', () => {
      const result = generateRandomString(100);
      // The ALPHABET used excludes ambiguous characters (0, O, l, 1)
      // but all chars should be alphanumeric
      expect(result).toMatch(/^[a-zA-Z0-9]+$/);
    });

    it('produces different strings on repeated calls', () => {
      const results = new Set<string>();
      for (let i = 0; i < 20; i++) {
        results.add(generateRandomString(32));
      }
      // With 32 chars from 57-char alphabet, collisions are astronomically unlikely
      expect(results.size).toBe(20);
    });
  });

  // ==========================================================================
  // extractApiKeyPrefix()
  // ==========================================================================

  describe('extractApiKeyPrefix()', () => {
    it('returns the prefix for a valid key', () => {
      const { key } = generateApiKey();
      const prefix = extractApiKeyPrefix(key);
      expect(prefix).toBe('styrby_');
    });

    it('returns the prefix for any string starting with styrby_', () => {
      expect(extractApiKeyPrefix('styrby_anything')).toBe('styrby_');
    });

    it('returns null for a key with wrong prefix', () => {
      expect(extractApiKeyPrefix('invalid_abc123')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(extractApiKeyPrefix('')).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(extractApiKeyPrefix(null)).toBeNull();
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(extractApiKeyPrefix(undefined)).toBeNull();
    });

    it('returns null for non-string input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(extractApiKeyPrefix(12345)).toBeNull();
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(extractApiKeyPrefix({})).toBeNull();
    });
  });

  // ==========================================================================
  // isValidApiKeyFormat()
  // ==========================================================================

  describe('isValidApiKeyFormat()', () => {
    it('returns true for a correctly formatted key', () => {
      const { key } = generateApiKey();
      expect(isValidApiKeyFormat(key)).toBe(true);
    });

    it('returns true for multiple generated keys', () => {
      for (let i = 0; i < 10; i++) {
        const { key } = generateApiKey();
        expect(isValidApiKeyFormat(key)).toBe(true);
      }
    });

    it('rejects a key with wrong prefix', () => {
      expect(isValidApiKeyFormat('wrong_abcdefghijklmnopqrstuvwxyz123456')).toBe(false);
    });

    it('rejects a key with correct prefix but wrong random length (too short)', () => {
      expect(isValidApiKeyFormat('styrby_short')).toBe(false);
    });

    it('rejects a key with correct prefix but wrong random length (too long)', () => {
      expect(isValidApiKeyFormat('styrby_' + 'a'.repeat(64))).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidApiKeyFormat('')).toBe(false);
    });

    it('rejects null input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(isValidApiKeyFormat(null)).toBe(false);
    });

    it('rejects undefined input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(isValidApiKeyFormat(undefined)).toBe(false);
    });

    it('rejects a key with special characters in the random part', () => {
      expect(isValidApiKeyFormat('styrby_abcdefgh!@#$%^&*()ijklmnop12')).toBe(false);
    });

    it('rejects just the prefix with no random part', () => {
      expect(isValidApiKeyFormat('styrby_')).toBe(false);
    });
  });

  // ==========================================================================
  // maskApiKey()
  // ==========================================================================

  describe('maskApiKey()', () => {
    it('masks the middle of a valid key showing first 4 and last 4 of random part', () => {
      const { key } = generateApiKey();
      const masked = maskApiKey(key);

      // Should start with prefix + first 4 chars of random
      expect(masked.startsWith('styrby_')).toBe(true);
      expect(masked).toContain('...');

      // Extract the visible parts
      const parts = masked.split('...');
      expect(parts.length).toBe(2);
      // First part: "styrby_" + first 4 chars
      expect(parts[0].length).toBe(API_KEY_PREFIX.length + 4);
      // Last part: last 4 chars
      expect(parts[1].length).toBe(4);
    });

    it('returns empty string for empty input', () => {
      expect(maskApiKey('')).toBe('');
    });

    it('returns empty string for null input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(maskApiKey(null)).toBe('');
    });

    it('returns empty string for undefined input', () => {
      // @ts-expect-error -- testing runtime behavior with invalid input
      expect(maskApiKey(undefined)).toBe('');
    });

    it('masks short keys without a valid prefix', () => {
      // Keys <= 8 chars without a valid prefix get fully masked
      expect(maskApiKey('short')).toBe('********');
      expect(maskApiKey('12345678')).toBe('********');
    });

    it('partially masks longer keys without a valid prefix', () => {
      const masked = maskApiKey('invalid_key_that_is_long_enough');
      expect(masked.startsWith('inva')).toBe(true);
      expect(masked).toContain('...');
      expect(masked.endsWith('ough')).toBe(true);
    });

    it('handles a key with valid prefix but short random part', () => {
      const masked = maskApiKey('styrby_abcd');
      // Random part is 4 chars, which is <= 8, so returns prefix + ****
      expect(masked).toBe('styrby_****');
    });
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('API Key Constants', () => {
    it('API_KEY_PREFIX is styrby_', () => {
      expect(API_KEY_PREFIX).toBe('styrby_');
    });

    it('API_KEY_RANDOM_LENGTH is 32', () => {
      expect(API_KEY_RANDOM_LENGTH).toBe(32);
    });
  });
});
