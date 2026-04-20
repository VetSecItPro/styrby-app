/**
 * Tests for the Styrby E2E Encryption Module (libsodium-backed).
 *
 * Validates crypto_box (public-key authenticated encryption) operations
 * including key generation, encrypt/decrypt round-trips, base64 encoding,
 * fingerprint generation, and the new XChaCha20-Poly1305 stream primitive.
 *
 * Every operation is async because libsodium's WASM init is async; the tests
 * mirror the production API.
 *
 * Dependencies: libsodium-wrappers (runtime); tweetnacl (devDep, used only
 * by the sibling compat test to prove byte-for-byte interop).
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  encrypt,
  decrypt,
  encryptForStorage,
  decryptFromStorage,
  encodeBase64,
  decodeBase64,
  generateFingerprint,
  encryptStream,
  decryptStream,
  XCHACHA20_KEY_BYTES,
  XCHACHA20_NONCE_BYTES,
} from '../src/encryption';

describe('Encryption Module (libsodium)', () => {
  // ==========================================================================
  // Key Generation
  // ==========================================================================

  describe('generateKeyPair()', () => {
    it('returns an object with publicKey and secretKey', async () => {
      const keypair = await generateKeyPair();
      expect(keypair).toHaveProperty('publicKey');
      expect(keypair).toHaveProperty('secretKey');
    });

    it('returns a publicKey that is a Uint8Array of 32 bytes', async () => {
      const keypair = await generateKeyPair();
      expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keypair.publicKey.length).toBe(32);
    });

    it('returns a secretKey that is a Uint8Array of 32 bytes', async () => {
      const keypair = await generateKeyPair();
      expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
      expect(keypair.secretKey.length).toBe(32);
    });

    it('generates different keypairs on each call', async () => {
      const keypair1 = await generateKeyPair();
      const keypair2 = await generateKeyPair();
      expect(keypair1.publicKey).not.toEqual(keypair2.publicKey);
      expect(keypair1.secretKey).not.toEqual(keypair2.secretKey);
    });
  });

  // ==========================================================================
  // Encrypt + Decrypt Round-Trip
  // ==========================================================================

  describe('encrypt() + decrypt() round-trip', () => {
    it('encrypts and decrypts a simple message', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const message = 'Hello from mobile!';

      const { encrypted, nonce } = await encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = await decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('encrypts and decrypts a message with unicode characters', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const message = 'Hello! Symbols: @#$%^&*() and Unicode: éàüñ 🔐';

      const { encrypted, nonce } = await encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = await decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('encrypts and decrypts a long message', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const message = 'A'.repeat(10000);

      const { encrypted, nonce } = await encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = await decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('produces different ciphertext for the same message (unique nonces)', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const message = 'Same message, different nonces';

      const result1 = await encrypt(message, recipient.publicKey, sender.secretKey);
      const result2 = await encrypt(message, recipient.publicKey, sender.secretKey);

      expect(result1.nonce).not.toEqual(result2.nonce);
      expect(result1.encrypted).not.toEqual(result2.encrypted);
    });
  });

  // ==========================================================================
  // Encrypt Failures
  // ==========================================================================

  describe('encrypt() with wrong keys fails', () => {
    it('fails to decrypt with the wrong recipient secret key', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const wrongRecipient = await generateKeyPair();
      const message = 'Secret message';

      const { encrypted, nonce } = await encrypt(message, recipient.publicKey, sender.secretKey);

      await expect(
        decrypt(encrypted, nonce, sender.publicKey, wrongRecipient.secretKey),
      ).rejects.toThrow('Decryption failed');
    });

    it('fails to decrypt with the wrong sender public key', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const wrongSender = await generateKeyPair();
      const message = 'Secret message';

      const { encrypted, nonce } = await encrypt(message, recipient.publicKey, sender.secretKey);

      await expect(
        decrypt(encrypted, nonce, wrongSender.publicKey, recipient.secretKey),
      ).rejects.toThrow('Decryption failed');
    });
  });

  describe('encrypt() with empty message throws', () => {
    it('throws an error when message is empty string', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();

      await expect(encrypt('', recipient.publicKey, sender.secretKey)).rejects.toThrow(
        'Cannot encrypt empty message',
      );
    });
  });

  describe('encrypt() with invalid key length throws', () => {
    it('throws when recipient public key is too short', async () => {
      const sender = await generateKeyPair();
      const shortKey = new Uint8Array(16);

      await expect(encrypt('Hello', shortKey, sender.secretKey)).rejects.toThrow(
        'Invalid recipient public key length: expected 32, got 16',
      );
    });

    it('throws when recipient public key is too long', async () => {
      const sender = await generateKeyPair();
      const longKey = new Uint8Array(64);

      await expect(encrypt('Hello', longKey, sender.secretKey)).rejects.toThrow(
        'Invalid recipient public key length: expected 32, got 64',
      );
    });

    it('throws when sender secret key is too short', async () => {
      const recipient = await generateKeyPair();
      const shortKey = new Uint8Array(16);

      await expect(encrypt('Hello', recipient.publicKey, shortKey)).rejects.toThrow(
        'Invalid sender secret key length: expected 32, got 16',
      );
    });

    it('throws when sender secret key is too long', async () => {
      const recipient = await generateKeyPair();
      const longKey = new Uint8Array(64);

      await expect(encrypt('Hello', recipient.publicKey, longKey)).rejects.toThrow(
        'Invalid sender secret key length: expected 32, got 64',
      );
    });
  });

  // ==========================================================================
  // Decrypt Validation
  // ==========================================================================

  describe('decrypt() input validation', () => {
    it('throws when nonce has invalid length', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const badNonce = new Uint8Array(10);

      await expect(
        decrypt(new Uint8Array(32), badNonce, sender.publicKey, recipient.secretKey),
      ).rejects.toThrow('Invalid nonce length');
    });

    it('throws when sender public key has invalid length', async () => {
      const recipient = await generateKeyPair();
      const badKey = new Uint8Array(16);
      const nonce = new Uint8Array(24);

      await expect(
        decrypt(new Uint8Array(32), nonce, badKey, recipient.secretKey),
      ).rejects.toThrow('Invalid sender public key length');
    });

    it('throws when recipient secret key has invalid length', async () => {
      const sender = await generateKeyPair();
      const badKey = new Uint8Array(16);
      const nonce = new Uint8Array(24);

      await expect(
        decrypt(new Uint8Array(32), nonce, sender.publicKey, badKey),
      ).rejects.toThrow('Invalid recipient secret key length');
    });
  });

  // ==========================================================================
  // Base64 Storage Round-Trip
  // ==========================================================================

  describe('encryptForStorage() + decryptFromStorage() round-trip', () => {
    it('encrypts to base64 and decrypts back to original message', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();
      const message = 'Hello from the storage layer!';

      const { encrypted, nonce } = await encryptForStorage(
        message,
        recipient.publicKey,
        sender.secretKey,
      );

      expect(typeof encrypted).toBe('string');
      expect(typeof nonce).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
      expect(nonce.length).toBeGreaterThan(0);

      const decrypted = await decryptFromStorage(
        encrypted,
        nonce,
        sender.publicKey,
        recipient.secretKey,
      );

      expect(decrypted).toBe(message);
    });

    it('produces valid base64 strings (standard variant, padded)', async () => {
      const sender = await generateKeyPair();
      const recipient = await generateKeyPair();

      const { encrypted, nonce } = await encryptForStorage(
        'Test message',
        recipient.publicKey,
        sender.secretKey,
      );

      const base64Regex = /^[A-Za-z0-9+/]+=*$/;
      expect(encrypted).toMatch(base64Regex);
      expect(nonce).toMatch(base64Regex);
    });
  });

  // ==========================================================================
  // Base64 Encoding/Decoding
  // ==========================================================================

  describe('encodeBase64() + decodeBase64() round-trip', () => {
    it('encodes and decodes a Uint8Array', async () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
      const encoded = await encodeBase64(original);
      const decoded = await decodeBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('encodes and decodes an empty Uint8Array', async () => {
      const original = new Uint8Array(0);
      const encoded = await encodeBase64(original);
      const decoded = await decodeBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('encodes and decodes a 32-byte key', async () => {
      const keypair = await generateKeyPair();
      const encoded = await encodeBase64(keypair.publicKey);
      const decoded = await decodeBase64(encoded);

      expect(decoded).toEqual(keypair.publicKey);
    });

    it('returns a string from encodeBase64', async () => {
      const bytes = new Uint8Array([0, 128, 255]);
      const encoded = await encodeBase64(bytes);
      expect(typeof encoded).toBe('string');
    });

    it('returns a Uint8Array from decodeBase64', async () => {
      const bytes = new Uint8Array([10, 20, 30]);
      const encoded = await encodeBase64(bytes);
      const decoded = await decodeBase64(encoded);
      expect(decoded).toBeInstanceOf(Uint8Array);
    });
  });

  // ==========================================================================
  // Fingerprint Generation
  // ==========================================================================

  describe('generateFingerprint()', () => {
    it('returns a 16-character hex string', async () => {
      const keypair = await generateKeyPair();
      const fingerprint = await generateFingerprint(keypair.publicKey);

      expect(typeof fingerprint).toBe('string');
      expect(fingerprint.length).toBe(16);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns the same fingerprint for the same key', async () => {
      const keypair = await generateKeyPair();
      const fingerprint1 = await generateFingerprint(keypair.publicKey);
      const fingerprint2 = await generateFingerprint(keypair.publicKey);

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('returns different fingerprints for different keypairs', async () => {
      const keypair1 = await generateKeyPair();
      const keypair2 = await generateKeyPair();

      const fingerprint1 = await generateFingerprint(keypair1.publicKey);
      const fingerprint2 = await generateFingerprint(keypair2.publicKey);

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('produces only lowercase hex characters', async () => {
      const keypair = await generateKeyPair();
      const fingerprint = await generateFingerprint(keypair.publicKey);

      expect(fingerprint).toBe(fingerprint.toLowerCase());
      for (const char of fingerprint) {
        expect('0123456789abcdef').toContain(char);
      }
    });
  });

  // ==========================================================================
  // XChaCha20-Poly1305 Stream Primitive
  // ==========================================================================

  describe('encryptStream() + decryptStream() round-trip', () => {
    function randomKey(): Uint8Array {
      const k = new Uint8Array(XCHACHA20_KEY_BYTES);
      crypto.getRandomValues(k);
      return k;
    }

    it('encrypts and decrypts binary bytes without AAD', async () => {
      const key = randomKey();
      const plaintext = new TextEncoder().encode('stream payload, no AAD');

      const { ciphertext, nonce } = await encryptStream(plaintext, key);
      expect(nonce.length).toBe(XCHACHA20_NONCE_BYTES);

      const decrypted = await decryptStream(ciphertext, nonce, key);
      expect(new TextDecoder().decode(decrypted)).toBe('stream payload, no AAD');
    });

    it('encrypts and decrypts binary bytes with AAD binding', async () => {
      const key = randomKey();
      const plaintext = new TextEncoder().encode('stream payload with AAD');
      const aad = new TextEncoder().encode('message-id:abc-123');

      const { ciphertext, nonce } = await encryptStream(plaintext, key, aad);
      const decrypted = await decryptStream(ciphertext, nonce, key, aad);

      expect(new TextDecoder().decode(decrypted)).toBe('stream payload with AAD');
    });

    it('fails when AAD differs at decrypt time', async () => {
      const key = randomKey();
      const plaintext = new TextEncoder().encode('payload');
      const aad = new TextEncoder().encode('message-id:abc-123');
      const wrongAad = new TextEncoder().encode('message-id:xyz-999');

      const { ciphertext, nonce } = await encryptStream(plaintext, key, aad);

      await expect(decryptStream(ciphertext, nonce, key, wrongAad)).rejects.toThrow(
        'Stream decryption failed',
      );
    });

    it('fails when key differs at decrypt time', async () => {
      const key1 = randomKey();
      const key2 = randomKey();
      const plaintext = new TextEncoder().encode('payload');

      const { ciphertext, nonce } = await encryptStream(plaintext, key1);

      await expect(decryptStream(ciphertext, nonce, key2)).rejects.toThrow(
        'Stream decryption failed',
      );
    });

    it('throws when key length is wrong on encrypt', async () => {
      const shortKey = new Uint8Array(16);
      const plaintext = new TextEncoder().encode('x');

      await expect(encryptStream(plaintext, shortKey)).rejects.toThrow('Invalid key length');
    });

    it('throws when nonce length is wrong on decrypt', async () => {
      const key = randomKey();
      const ciphertext = new Uint8Array(32);
      const badNonce = new Uint8Array(10);

      await expect(decryptStream(ciphertext, badNonce, key)).rejects.toThrow(
        'Invalid nonce length',
      );
    });

    it('produces different ciphertexts for the same plaintext (unique nonces)', async () => {
      const key = randomKey();
      const plaintext = new TextEncoder().encode('same text, different nonces');

      const result1 = await encryptStream(plaintext, key);
      const result2 = await encryptStream(plaintext, key);

      expect(result1.nonce).not.toEqual(result2.nonce);
      expect(result1.ciphertext).not.toEqual(result2.ciphertext);
    });
  });
});
