/**
 * Tests for the Styrby E2E Encryption Module
 *
 * Validates NaCl box (public-key authenticated encryption) operations
 * including key generation, encrypt/decrypt round-trips, base64 encoding,
 * and fingerprint generation.
 *
 * Dependencies: tweetnacl, tweetnacl-util (installed in package)
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
} from '../src/encryption';

describe('Encryption Module', () => {
  // ==========================================================================
  // Key Generation
  // ==========================================================================

  describe('generateKeyPair()', () => {
    it('returns an object with publicKey and secretKey', () => {
      const keypair = generateKeyPair();
      expect(keypair).toHaveProperty('publicKey');
      expect(keypair).toHaveProperty('secretKey');
    });

    it('returns a publicKey that is a Uint8Array of 32 bytes', () => {
      const keypair = generateKeyPair();
      expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keypair.publicKey.length).toBe(32);
    });

    it('returns a secretKey that is a Uint8Array of 32 bytes', () => {
      const keypair = generateKeyPair();
      expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
      expect(keypair.secretKey.length).toBe(32);
    });

    it('generates different keypairs on each call', () => {
      const keypair1 = generateKeyPair();
      const keypair2 = generateKeyPair();
      expect(keypair1.publicKey).not.toEqual(keypair2.publicKey);
      expect(keypair1.secretKey).not.toEqual(keypair2.secretKey);
    });
  });

  // ==========================================================================
  // Encrypt + Decrypt Round-Trip
  // ==========================================================================

  describe('encrypt() + decrypt() round-trip', () => {
    it('encrypts and decrypts a simple message', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const message = 'Hello from mobile!';

      const { encrypted, nonce } = encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('encrypts and decrypts a message with unicode characters', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const message = 'Hello! Symbols: @#$%^&*() and Unicode: \u00e9\u00e0\u00fc\u00f1';

      const { encrypted, nonce } = encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('encrypts and decrypts a long message', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const message = 'A'.repeat(10000);

      const { encrypted, nonce } = encrypt(message, recipient.publicKey, sender.secretKey);
      const decrypted = decrypt(encrypted, nonce, sender.publicKey, recipient.secretKey);

      expect(decrypted).toBe(message);
    });

    it('produces different ciphertext for the same message (unique nonces)', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const message = 'Same message, different nonces';

      const result1 = encrypt(message, recipient.publicKey, sender.secretKey);
      const result2 = encrypt(message, recipient.publicKey, sender.secretKey);

      expect(result1.nonce).not.toEqual(result2.nonce);
      expect(result1.encrypted).not.toEqual(result2.encrypted);
    });
  });

  // ==========================================================================
  // Encrypt Failures
  // ==========================================================================

  describe('encrypt() with wrong keys fails', () => {
    it('fails to decrypt with the wrong recipient secret key', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const wrongRecipient = generateKeyPair();
      const message = 'Secret message';

      const { encrypted, nonce } = encrypt(message, recipient.publicKey, sender.secretKey);

      expect(() => {
        decrypt(encrypted, nonce, sender.publicKey, wrongRecipient.secretKey);
      }).toThrow('Decryption failed');
    });

    it('fails to decrypt with the wrong sender public key', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const wrongSender = generateKeyPair();
      const message = 'Secret message';

      const { encrypted, nonce } = encrypt(message, recipient.publicKey, sender.secretKey);

      expect(() => {
        decrypt(encrypted, nonce, wrongSender.publicKey, recipient.secretKey);
      }).toThrow('Decryption failed');
    });
  });

  describe('encrypt() with empty message throws', () => {
    it('throws an error when message is empty string', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();

      expect(() => {
        encrypt('', recipient.publicKey, sender.secretKey);
      }).toThrow('Cannot encrypt empty message');
    });
  });

  describe('encrypt() with invalid key length throws', () => {
    it('throws when recipient public key is too short', () => {
      const sender = generateKeyPair();
      const shortKey = new Uint8Array(16);

      expect(() => {
        encrypt('Hello', shortKey, sender.secretKey);
      }).toThrow('Invalid recipient public key length: expected 32, got 16');
    });

    it('throws when recipient public key is too long', () => {
      const sender = generateKeyPair();
      const longKey = new Uint8Array(64);

      expect(() => {
        encrypt('Hello', longKey, sender.secretKey);
      }).toThrow('Invalid recipient public key length: expected 32, got 64');
    });

    it('throws when sender secret key is too short', () => {
      const recipient = generateKeyPair();
      const shortKey = new Uint8Array(16);

      expect(() => {
        encrypt('Hello', recipient.publicKey, shortKey);
      }).toThrow('Invalid sender secret key length: expected 32, got 16');
    });

    it('throws when sender secret key is too long', () => {
      const recipient = generateKeyPair();
      const longKey = new Uint8Array(64);

      expect(() => {
        encrypt('Hello', recipient.publicKey, longKey);
      }).toThrow('Invalid sender secret key length: expected 32, got 64');
    });
  });

  // ==========================================================================
  // Decrypt Validation
  // ==========================================================================

  describe('decrypt() input validation', () => {
    it('throws when nonce has invalid length', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const badNonce = new Uint8Array(10);

      expect(() => {
        decrypt(new Uint8Array(32), badNonce, sender.publicKey, recipient.secretKey);
      }).toThrow('Invalid nonce length');
    });

    it('throws when sender public key has invalid length', () => {
      const recipient = generateKeyPair();
      const badKey = new Uint8Array(16);
      const nonce = new Uint8Array(24);

      expect(() => {
        decrypt(new Uint8Array(32), nonce, badKey, recipient.secretKey);
      }).toThrow('Invalid sender public key length');
    });

    it('throws when recipient secret key has invalid length', () => {
      const sender = generateKeyPair();
      const badKey = new Uint8Array(16);
      const nonce = new Uint8Array(24);

      expect(() => {
        decrypt(new Uint8Array(32), nonce, sender.publicKey, badKey);
      }).toThrow('Invalid recipient secret key length');
    });
  });

  // ==========================================================================
  // Base64 Storage Round-Trip
  // ==========================================================================

  describe('encryptForStorage() + decryptFromStorage() round-trip', () => {
    it('encrypts to base64 and decrypts back to original message', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const message = 'Hello from the storage layer!';

      const { encrypted, nonce } = encryptForStorage(
        message,
        recipient.publicKey,
        sender.secretKey
      );

      // Verify the results are base64 strings
      expect(typeof encrypted).toBe('string');
      expect(typeof nonce).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
      expect(nonce.length).toBeGreaterThan(0);

      const decrypted = decryptFromStorage(
        encrypted,
        nonce,
        sender.publicKey,
        recipient.secretKey
      );

      expect(decrypted).toBe(message);
    });

    it('produces valid base64 strings', () => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();

      const { encrypted, nonce } = encryptForStorage(
        'Test message',
        recipient.publicKey,
        sender.secretKey
      );

      // Base64 strings should only contain valid characters
      const base64Regex = /^[A-Za-z0-9+/]+=*$/;
      expect(encrypted).toMatch(base64Regex);
      expect(nonce).toMatch(base64Regex);
    });
  });

  // ==========================================================================
  // Base64 Encoding/Decoding
  // ==========================================================================

  describe('encodeBase64() + decodeBase64() round-trip', () => {
    it('encodes and decodes a Uint8Array', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
      const encoded = encodeBase64(original);
      const decoded = decodeBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('encodes and decodes an empty Uint8Array', () => {
      const original = new Uint8Array(0);
      const encoded = encodeBase64(original);
      const decoded = decodeBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('encodes and decodes a 32-byte key', () => {
      const keypair = generateKeyPair();
      const encoded = encodeBase64(keypair.publicKey);
      const decoded = decodeBase64(encoded);

      expect(decoded).toEqual(keypair.publicKey);
    });

    it('returns a string from encodeBase64', () => {
      const bytes = new Uint8Array([0, 128, 255]);
      const encoded = encodeBase64(bytes);
      expect(typeof encoded).toBe('string');
    });

    it('returns a Uint8Array from decodeBase64', () => {
      const bytes = new Uint8Array([10, 20, 30]);
      const encoded = encodeBase64(bytes);
      const decoded = decodeBase64(encoded);
      expect(decoded).toBeInstanceOf(Uint8Array);
    });
  });

  // ==========================================================================
  // Fingerprint Generation
  // ==========================================================================

  describe('generateFingerprint()', () => {
    it('returns a 16-character hex string', async () => {
      const keypair = generateKeyPair();
      const fingerprint = await generateFingerprint(keypair.publicKey);

      expect(typeof fingerprint).toBe('string');
      expect(fingerprint.length).toBe(16);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns the same fingerprint for the same key', async () => {
      const keypair = generateKeyPair();
      const fingerprint1 = await generateFingerprint(keypair.publicKey);
      const fingerprint2 = await generateFingerprint(keypair.publicKey);

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('returns different fingerprints for different keypairs', async () => {
      const keypair1 = generateKeyPair();
      const keypair2 = generateKeyPair();

      const fingerprint1 = await generateFingerprint(keypair1.publicKey);
      const fingerprint2 = await generateFingerprint(keypair2.publicKey);

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('produces only lowercase hex characters', async () => {
      const keypair = generateKeyPair();
      const fingerprint = await generateFingerprint(keypair.publicKey);

      // Verify no uppercase letters
      expect(fingerprint).toBe(fingerprint.toLowerCase());
      // Verify only hex chars
      for (const char of fingerprint) {
        expect('0123456789abcdef').toContain(char);
      }
    });
  });
});
