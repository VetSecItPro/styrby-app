import { describe, it, expect } from 'vitest';
import {
  hashApiKey,
  verifyApiKey,
  hashApiKeySync,
  verifyApiKeySync,
} from '../api-keys';

/**
 * Test suite for API key hashing and verification utilities.
 *
 * Note: These tests are intentionally slow (~300ms per hash operation)
 * due to bcrypt's cost factor of 12, which is required for security.
 */
describe('api-keys', () => {
  const TEST_KEY = 'sk_test_1234567890abcdefghijklmnopqrstuvwxyz';
  const DIFFERENT_KEY = 'sk_test_different_key_9876543210';

  describe('hashApiKey (async)', () => {
    it('returns a bcrypt hash string starting with $2b$', async () => {
      const hash = await hashApiKey(TEST_KEY);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^\$2b\$/);
      expect(hash.length).toBeGreaterThan(50); // bcrypt hashes are ~60 chars
    }, 10000); // 10s timeout

    it('produces different hashes for the same key (salted)', async () => {
      const hash1 = await hashApiKey(TEST_KEY);
      const hash2 = await hashApiKey(TEST_KEY);

      expect(hash1).not.toBe(hash2); // Different salts
      // But both should verify with the original key
      expect(await verifyApiKey(TEST_KEY, hash1)).toBe(true);
      expect(await verifyApiKey(TEST_KEY, hash2)).toBe(true);
    }, 10000);

    it('throws on empty string', async () => {
      await expect(hashApiKey('')).rejects.toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on null input', async () => {
      await expect(hashApiKey(null as any)).rejects.toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on undefined input', async () => {
      await expect(hashApiKey(undefined as any)).rejects.toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on non-string input', async () => {
      await expect(hashApiKey(12345 as any)).rejects.toThrow('Invalid API key: must be a non-empty string');
    });
  });

  describe('verifyApiKey (async)', () => {
    it('returns true for matching key/hash pair', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = await verifyApiKey(TEST_KEY, hash);

      expect(isValid).toBe(true);
    }, 10000);

    it('returns false for wrong key', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = await verifyApiKey(DIFFERENT_KEY, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for empty key', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = await verifyApiKey('' as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for empty hash', async () => {
      const isValid = await verifyApiKey(TEST_KEY, '' as any);

      expect(isValid).toBe(false);
    });

    it('returns false for null key', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = await verifyApiKey(null as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for null hash', async () => {
      const isValid = await verifyApiKey(TEST_KEY, null as any);

      expect(isValid).toBe(false);
    });

    it('returns false for undefined key', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = await verifyApiKey(undefined as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for undefined hash', async () => {
      const isValid = await verifyApiKey(TEST_KEY, undefined as any);

      expect(isValid).toBe(false);
    });

    it('returns false for malformed hash', async () => {
      const isValid = await verifyApiKey(TEST_KEY, 'not-a-valid-bcrypt-hash');

      expect(isValid).toBe(false);
    });
  });

  describe('hashApiKeySync', () => {
    it('returns a bcrypt hash string starting with $2b$', () => {
      const hash = hashApiKeySync(TEST_KEY);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^\$2b\$/);
      expect(hash.length).toBeGreaterThan(50);
    }, 10000);

    it('produces different hashes for the same key (salted)', () => {
      const hash1 = hashApiKeySync(TEST_KEY);
      const hash2 = hashApiKeySync(TEST_KEY);

      expect(hash1).not.toBe(hash2); // Different salts
      // But both should verify with the original key
      expect(verifyApiKeySync(TEST_KEY, hash1)).toBe(true);
      expect(verifyApiKeySync(TEST_KEY, hash2)).toBe(true);
    }, 10000);

    it('throws on empty string', () => {
      expect(() => hashApiKeySync('')).toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on null input', () => {
      expect(() => hashApiKeySync(null as any)).toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on undefined input', () => {
      expect(() => hashApiKeySync(undefined as any)).toThrow('Invalid API key: must be a non-empty string');
    });

    it('throws on non-string input', () => {
      expect(() => hashApiKeySync(12345 as any)).toThrow('Invalid API key: must be a non-empty string');
    });
  });

  describe('verifyApiKeySync', () => {
    it('returns true for matching key/hash pair', () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = verifyApiKeySync(TEST_KEY, hash);

      expect(isValid).toBe(true);
    }, 10000);

    it('returns false for wrong key', () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = verifyApiKeySync(DIFFERENT_KEY, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for empty key', () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = verifyApiKeySync('' as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for empty hash', () => {
      const isValid = verifyApiKeySync(TEST_KEY, '' as any);

      expect(isValid).toBe(false);
    });

    it('returns false for null key', () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = verifyApiKeySync(null as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for null hash', () => {
      const isValid = verifyApiKeySync(TEST_KEY, null as any);

      expect(isValid).toBe(false);
    });

    it('returns false for undefined key', () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = verifyApiKeySync(undefined as any, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('returns false for undefined hash', () => {
      const isValid = verifyApiKeySync(TEST_KEY, undefined as any);

      expect(isValid).toBe(false);
    });

    it('returns false for malformed hash', () => {
      const isValid = verifyApiKeySync(TEST_KEY, 'not-a-valid-bcrypt-hash');

      expect(isValid).toBe(false);
    });
  });

  describe('cross-compatibility (async/sync)', () => {
    it('async hash can be verified by sync verify', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = verifyApiKeySync(TEST_KEY, hash);

      expect(isValid).toBe(true);
    }, 10000);

    it('sync hash can be verified by async verify', async () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = await verifyApiKey(TEST_KEY, hash);

      expect(isValid).toBe(true);
    }, 10000);

    it('async hash rejects wrong key with sync verify', async () => {
      const hash = await hashApiKey(TEST_KEY);
      const isValid = verifyApiKeySync(DIFFERENT_KEY, hash);

      expect(isValid).toBe(false);
    }, 10000);

    it('sync hash rejects wrong key with async verify', async () => {
      const hash = hashApiKeySync(TEST_KEY);
      const isValid = await verifyApiKey(DIFFERENT_KEY, hash);

      expect(isValid).toBe(false);
    }, 10000);
  });
});
