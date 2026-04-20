/**
 * Tests for session/encryption.ts
 *
 * Covers:
 * - deriveSessionKey: deterministic key derivation from same context
 * - encryptMessage: produces a valid EncryptedPayload with base64 fields
 * - decryptMessage: roundtrip succeeds; wrong key throws
 * - isEncryptedPayload: type guard for all branches
 * - generateRandomKey: produces 32-byte unique random keys
 *
 * WHY: Encryption is the highest-risk module in the CLI. A regression here
 * means plaintext messages reach Supabase — an irreversible privacy breach.
 * Pure-function tests catch regressions without any network or FS access.
 *
 * @module session/__tests__/encryption
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  isEncryptedPayload,
  generateRandomKey,
  type EncryptedPayload,
  type KeyContext,
} from '../encryption';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * A deterministic user secret for testing.
 * 32 bytes, chosen arbitrarily — same across all tests for reproducibility.
 */
const TEST_USER_SECRET = new Uint8Array(32).fill(0x42);

/**
 * Base key derivation context used in most tests.
 */
const BASE_CONTEXT: KeyContext = {
  userSecret: TEST_USER_SECRET,
  sessionId: 'session-uuid-abc-123',
  machineId: 'machine-uuid-xyz-456',
};

// ============================================================================
// deriveSessionKey
// ============================================================================

describe('deriveSessionKey', () => {
  it('returns a 32-byte Uint8Array', async () => {
    const key = await deriveSessionKey(BASE_CONTEXT);

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('is deterministic — same context always produces same key', async () => {
    const key1 = await deriveSessionKey(BASE_CONTEXT);
    const key2 = await deriveSessionKey(BASE_CONTEXT);

    expect(key1).toEqual(key2);
  });

  it('produces different keys for different sessionIds', async () => {
    const key1 = await deriveSessionKey(BASE_CONTEXT);
    const key2 = await deriveSessionKey({
      ...BASE_CONTEXT,
      sessionId: 'session-uuid-different-999',
    });

    expect(key1).not.toEqual(key2);
  });

  it('produces different keys for different machineIds', async () => {
    const key1 = await deriveSessionKey(BASE_CONTEXT);
    const key2 = await deriveSessionKey({
      ...BASE_CONTEXT,
      machineId: 'machine-uuid-different-999',
    });

    expect(key1).not.toEqual(key2);
  });

  it('produces different keys for different user secrets', async () => {
    const key1 = await deriveSessionKey(BASE_CONTEXT);
    const key2 = await deriveSessionKey({
      ...BASE_CONTEXT,
      userSecret: new Uint8Array(32).fill(0x99),
    });

    expect(key1).not.toEqual(key2);
  });

  it('does not mutate the userSecret buffer', async () => {
    const secret = new Uint8Array(32).fill(0x42);
    const snapshot = Uint8Array.from(secret);

    await deriveSessionKey({ ...BASE_CONTEXT, userSecret: secret });

    expect(secret).toEqual(snapshot);
  });
});

// ============================================================================
// encryptMessage
// ============================================================================

describe('encryptMessage', () => {
  let testKey: Uint8Array;

  beforeAll(async () => {
    testKey = await deriveSessionKey(BASE_CONTEXT);
  });

  it('returns an EncryptedPayload with contentEncrypted and nonce fields', async () => {
    const payload = await encryptMessage('Hello, world!', testKey);

    expect(typeof payload.contentEncrypted).toBe('string');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.contentEncrypted.length).toBeGreaterThan(0);
    expect(payload.nonce.length).toBeGreaterThan(0);
  });

  it('nonce is 24 bytes when decoded (base64 of 24 bytes = 32 base64 chars)', async () => {
    const payload = await encryptMessage('test', testKey);

    // Base64 of 24 bytes with no padding = ceil(24 * 4/3) = 32 chars
    const nonceBytes = Buffer.from(payload.nonce, 'base64');
    expect(nonceBytes.length).toBe(24);
  });

  it('ciphertext length is greater than plaintext length (has MAC overhead)', async () => {
    const plaintext = 'Secret message content here.';
    const payload = await encryptMessage(plaintext, testKey);

    // XSalsa20-Poly1305 adds 16 bytes of authentication tag
    const cipherLen = Buffer.from(payload.contentEncrypted, 'base64').length;
    expect(cipherLen).toBeGreaterThan(plaintext.length);
  });

  it('produces different ciphertext each call for same plaintext (random nonce)', async () => {
    const payload1 = await encryptMessage('Same message', testKey);
    const payload2 = await encryptMessage('Same message', testKey);

    // Nonces must differ
    expect(payload1.nonce).not.toBe(payload2.nonce);
    // Ciphertexts will also differ because nonce is part of the stream
    expect(payload1.contentEncrypted).not.toBe(payload2.contentEncrypted);
  });

  it('handles empty string plaintext', async () => {
    await expect(encryptMessage('', testKey)).resolves.toBeDefined();
    const payload = await encryptMessage('', testKey);
    expect(typeof payload.contentEncrypted).toBe('string');
  });

  it('handles Unicode plaintext', async () => {
    const unicode = '日本語テスト 🔐 тест';
    const payload = await encryptMessage(unicode, testKey);
    expect(typeof payload.contentEncrypted).toBe('string');
  });

  it('handles large plaintext (> 64 KB)', async () => {
    const large = 'x'.repeat(100_000);
    const payload = await encryptMessage(large, testKey);
    expect(typeof payload.contentEncrypted).toBe('string');
  });
});

// ============================================================================
// decryptMessage
// ============================================================================

describe('decryptMessage', () => {
  let testKey: Uint8Array;

  beforeAll(async () => {
    testKey = await deriveSessionKey(BASE_CONTEXT);
  });

  it('roundtrip: encrypt then decrypt returns original plaintext', async () => {
    const original = 'Roundtrip test message 🔒';
    const payload = await encryptMessage(original, testKey);
    const recovered = await decryptMessage(payload, testKey);

    expect(recovered).toBe(original);
  });

  it('roundtrip with empty string', async () => {
    const payload = await encryptMessage('', testKey);
    expect(await decryptMessage(payload, testKey)).toBe('');
  });

  it('roundtrip with multi-line JSON content', async () => {
    const json = JSON.stringify({ type: 'user_prompt', content: 'Fix the bug\nand tests' });
    const payload = await encryptMessage(json, testKey);
    expect(await decryptMessage(payload, testKey)).toBe(json);
  });

  it('roundtrip with Unicode characters', async () => {
    const unicode = '日本語テスト 🔐 тест مرحبا';
    const payload = await encryptMessage(unicode, testKey);
    expect(await decryptMessage(payload, testKey)).toBe(unicode);
  });

  it('throws when decrypting with a wrong key', async () => {
    const wrongKey = await generateRandomKey();
    const payload = await encryptMessage('Secret', testKey);

    await expect(decryptMessage(payload, wrongKey)).rejects.toThrow(
      'Decryption failed: invalid key or tampered data',
    );
  });

  it('throws when contentEncrypted has been tampered with', async () => {
    const payload = await encryptMessage('Tamper test', testKey);

    // Flip a few bytes in the ciphertext by modifying the base64
    const bytes = Buffer.from(payload.contentEncrypted, 'base64');
    bytes[0] ^= 0xff;
    const tampered: EncryptedPayload = {
      ...payload,
      contentEncrypted: bytes.toString('base64'),
    };

    await expect(decryptMessage(tampered, testKey)).rejects.toThrow(
      'Decryption failed: invalid key or tampered data',
    );
  });

  it('throws when nonce has been tampered with', async () => {
    const payload = await encryptMessage('Nonce tamper test', testKey);

    const nonceBytes = Buffer.from(payload.nonce, 'base64');
    nonceBytes[0] ^= 0xff;
    const tampered: EncryptedPayload = {
      ...payload,
      nonce: nonceBytes.toString('base64'),
    };

    await expect(decryptMessage(tampered, testKey)).rejects.toThrow(
      'Decryption failed: invalid key or tampered data',
    );
  });

  it('throws when decrypting a payload encrypted with a different session key', async () => {
    const otherKey = await deriveSessionKey({
      ...BASE_CONTEXT,
      sessionId: 'totally-different-session',
    });

    const payload = await encryptMessage('Wrong session', testKey);

    await expect(decryptMessage(payload, otherKey)).rejects.toThrow(
      'Decryption failed: invalid key or tampered data',
    );
  });
});

// ============================================================================
// isEncryptedPayload
// ============================================================================

describe('isEncryptedPayload', () => {
  it('returns true for a valid EncryptedPayload shape', () => {
    const payload: EncryptedPayload = {
      contentEncrypted: 'abc123==',
      nonce: 'xyz789==',
    };

    expect(isEncryptedPayload(payload)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isEncryptedPayload(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isEncryptedPayload(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isEncryptedPayload('not an object')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isEncryptedPayload(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isEncryptedPayload(['contentEncrypted', 'nonce'])).toBe(false);
  });

  it('returns false when contentEncrypted is missing', () => {
    expect(isEncryptedPayload({ nonce: 'xyz' })).toBe(false);
  });

  it('returns false when nonce is missing', () => {
    expect(isEncryptedPayload({ contentEncrypted: 'abc' })).toBe(false);
  });

  it('returns false when contentEncrypted is not a string', () => {
    expect(isEncryptedPayload({ contentEncrypted: 123, nonce: 'xyz' })).toBe(false);
  });

  it('returns false when nonce is not a string', () => {
    expect(isEncryptedPayload({ contentEncrypted: 'abc', nonce: null })).toBe(false);
  });

  it('returns true when extra fields are present (structural typing)', () => {
    expect(
      isEncryptedPayload({ contentEncrypted: 'abc', nonce: 'xyz', extra: 'field' })
    ).toBe(true);
  });

  it('narrows type correctly in TypeScript (type guard contract)', () => {
    const unknown: unknown = { contentEncrypted: 'data==', nonce: 'nonce==' };

    if (isEncryptedPayload(unknown)) {
      // TypeScript should allow these accesses inside the if block
      expect(unknown.contentEncrypted).toBe('data==');
      expect(unknown.nonce).toBe('nonce==');
    } else {
      throw new Error('Expected isEncryptedPayload to return true');
    }
  });
});

// ============================================================================
// generateRandomKey
// ============================================================================

describe('generateRandomKey', () => {
  it('returns a Uint8Array of exactly 32 bytes', async () => {
    const key = await generateRandomKey();

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('produces unique keys on each call', async () => {
    const keys = await Promise.all(
      Array.from({ length: 50 }, () => generateRandomKey()),
    );
    const hexKeys = keys.map((k) => Buffer.from(k).toString('hex'));
    const unique = new Set(hexKeys);

    expect(unique.size).toBe(50);
  });

  it('produces keys with high entropy — not all zeros or all same byte', async () => {
    const key = await generateRandomKey();
    const allZero = key.every((b) => b === 0);
    const allSame = key.every((b) => b === key[0]);

    expect(allZero).toBe(false);
    expect(allSame).toBe(false);
  });

  it('key can be used directly with encryptMessage without error', async () => {
    const key = await generateRandomKey();

    await expect(encryptMessage('test with random key', key)).resolves.toBeDefined();
  });

  it('key produced is compatible with decryptMessage roundtrip', async () => {
    const key = await generateRandomKey();
    const plaintext = 'generated key roundtrip';
    const payload = await encryptMessage(plaintext, key);

    expect(await decryptMessage(payload, key)).toBe(plaintext);
  });
});
