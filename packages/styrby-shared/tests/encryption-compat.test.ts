/**
 * Cross-library byte-compatibility tests for TweetNaCl ↔ libsodium.
 *
 * WHY this test exists: Production has data encrypted with TweetNaCl
 * (session_messages.content_encrypted, machine_keys.public_key, etc.).
 * The libsodium migration MUST preserve byte-for-byte compatibility or
 * existing rows become unreadable. These tests prove the two libraries
 * produce interoperable outputs for every primitive we use.
 *
 * The tests run against both libraries directly (not through our wrapper)
 * so they catch any implementation drift even if our wrapper logic changes.
 *
 * This test file is the canary: if it ever fails, the migration has
 * introduced a compat regression and must be rolled back.
 *
 * @module tests/encryption-compat
 */

import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import sodium from 'libsodium-wrappers';

beforeAll(async () => {
  await sodium.ready;
});

// ============================================================================
// Deterministic test vectors
// ============================================================================

/**
 * Fixed keypairs + nonce for byte-equality assertions.
 * WHY fixed: If we let libraries generate random keys, we can only test
 * round-trip semantics. Fixed inputs let us assert *exact* bytes match.
 */
const SENDER_SECRET = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

const RECIPIENT_SECRET = new Uint8Array([
  0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0,
  0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0,
]);

const FIXED_NONCE_24 = new Uint8Array(24).fill(0x42);
const PLAINTEXT = 'Styrby E2E test payload - the quick brown fox jumps over the lazy dog';

// ============================================================================
// nacl.box ↔ libsodium crypto_box (Curve25519 + XSalsa20-Poly1305)
// ============================================================================

describe('compat: nacl.box ↔ sodium.crypto_box (Curve25519+XSalsa20-Poly1305)', () => {
  it('both libraries derive identical public keys from the same secret', () => {
    const naclKp = nacl.box.keyPair.fromSecretKey(SENDER_SECRET);
    const sodiumPub = sodium.crypto_scalarmult_base(SENDER_SECRET);

    expect(Array.from(sodiumPub)).toEqual(Array.from(naclKp.publicKey));
  });

  it('TweetNaCl can decrypt libsodium ciphertext', () => {
    const senderKp = nacl.box.keyPair.fromSecretKey(SENDER_SECRET);
    const recipientKp = nacl.box.keyPair.fromSecretKey(RECIPIENT_SECRET);

    // Encrypt with libsodium
    const ciphertext = sodium.crypto_box_easy(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      recipientKp.publicKey,
      SENDER_SECRET,
    );

    // Decrypt with TweetNaCl
    const plaintextBytes = nacl.box.open(
      ciphertext,
      FIXED_NONCE_24,
      senderKp.publicKey,
      recipientKp.secretKey,
    );

    expect(plaintextBytes).not.toBeNull();
    expect(encodeUTF8(plaintextBytes!)).toBe(PLAINTEXT);
  });

  it('libsodium can decrypt TweetNaCl ciphertext', () => {
    const senderKp = nacl.box.keyPair.fromSecretKey(SENDER_SECRET);
    const recipientKp = nacl.box.keyPair.fromSecretKey(RECIPIENT_SECRET);

    // Encrypt with TweetNaCl
    const ciphertext = nacl.box(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      recipientKp.publicKey,
      SENDER_SECRET,
    );

    // Decrypt with libsodium
    const plaintextBytes = sodium.crypto_box_open_easy(
      ciphertext,
      FIXED_NONCE_24,
      senderKp.publicKey,
      recipientKp.secretKey,
    );

    expect(encodeUTF8(plaintextBytes)).toBe(PLAINTEXT);
  });

  it('both libraries produce byte-identical ciphertext for the same inputs', () => {
    const recipientPub = nacl.box.keyPair.fromSecretKey(RECIPIENT_SECRET).publicKey;

    const naclCt = nacl.box(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      recipientPub,
      SENDER_SECRET,
    );

    const sodiumCt = sodium.crypto_box_easy(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      recipientPub,
      SENDER_SECRET,
    );

    expect(Array.from(sodiumCt)).toEqual(Array.from(naclCt));
  });
});

// ============================================================================
// nacl.secretbox ↔ libsodium crypto_secretbox (XSalsa20-Poly1305)
// ============================================================================

describe('compat: nacl.secretbox ↔ sodium.crypto_secretbox (XSalsa20-Poly1305)', () => {
  it('TweetNaCl can decrypt libsodium secretbox ciphertext', () => {
    const key = new Uint8Array(32).fill(0x55);

    const ciphertext = sodium.crypto_secretbox_easy(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      key,
    );

    const plaintextBytes = nacl.secretbox.open(ciphertext, FIXED_NONCE_24, key);

    expect(plaintextBytes).not.toBeNull();
    expect(encodeUTF8(plaintextBytes!)).toBe(PLAINTEXT);
  });

  it('libsodium can decrypt TweetNaCl secretbox ciphertext', () => {
    const key = new Uint8Array(32).fill(0x55);

    const ciphertext = nacl.secretbox(decodeUTF8(PLAINTEXT), FIXED_NONCE_24, key);

    const plaintextBytes = sodium.crypto_secretbox_open_easy(
      ciphertext,
      FIXED_NONCE_24,
      key,
    );

    expect(encodeUTF8(plaintextBytes)).toBe(PLAINTEXT);
  });

  it('both produce byte-identical secretbox ciphertext', () => {
    const key = new Uint8Array(32).fill(0x55);

    const naclCt = nacl.secretbox(decodeUTF8(PLAINTEXT), FIXED_NONCE_24, key);
    const sodiumCt = sodium.crypto_secretbox_easy(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      key,
    );

    expect(Array.from(sodiumCt)).toEqual(Array.from(naclCt));
  });
});

// ============================================================================
// Tampering detection (both libraries must reject the same invalid inputs)
// ============================================================================

describe('compat: both libraries reject tampered ciphertext identically', () => {
  it('flipped bit in ciphertext -> both reject', () => {
    const senderPub = nacl.box.keyPair.fromSecretKey(SENDER_SECRET).publicKey;
    const recipientKp = nacl.box.keyPair.fromSecretKey(RECIPIENT_SECRET);

    const ciphertext = sodium.crypto_box_easy(
      decodeUTF8(PLAINTEXT),
      FIXED_NONCE_24,
      recipientKp.publicKey,
      SENDER_SECRET,
    );

    // Flip one bit in the middle of the ciphertext
    const tampered = new Uint8Array(ciphertext);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;

    expect(nacl.box.open(tampered, FIXED_NONCE_24, senderPub, recipientKp.secretKey)).toBeNull();

    expect(() =>
      sodium.crypto_box_open_easy(tampered, FIXED_NONCE_24, senderPub, recipientKp.secretKey),
    ).toThrow();
  });
});
