/**
 * Session Message Encryption
 *
 * Provides end-to-end encryption for session messages using TweetNaCl secretbox.
 * Messages are encrypted before being stored in Supabase, ensuring the server
 * never sees plaintext content.
 *
 * ## Encryption Scheme
 *
 * - Algorithm: XSalsa20-Poly1305 (TweetNaCl secretbox)
 * - Key derivation: HMAC-SHA512 from user seed + session context
 * - Nonce: Random 24 bytes per message (stored alongside ciphertext)
 *
 * ## Security Properties
 *
 * - Forward secrecy: Each session derives unique keys
 * - Authenticated encryption: Tampering is detected
 * - Random nonces: Safe to reuse key across messages
 *
 * @module session/encryption
 */

import nacl from 'tweetnacl';
import { encode as encodeBase64, decode as decodeBase64 } from '@stablelib/base64';
import { deriveKey } from '@/utils/deriveKey';

// ============================================================================
// Types
// ============================================================================

/**
 * Encrypted message payload ready for storage.
 */
export interface EncryptedPayload {
  /** Base64-encoded encrypted content */
  contentEncrypted: string;
  /** Base64-encoded nonce used for encryption */
  nonce: string;
}

/**
 * Encryption key context for deriving session-specific keys.
 */
export interface KeyContext {
  /** User's master secret (from auth) */
  userSecret: Uint8Array;
  /** Session ID for key derivation */
  sessionId: string;
  /** Machine ID for additional binding */
  machineId: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Key derivation usage string for session encryption.
 * Changes to this string invalidate all existing encrypted data.
 */
const KEY_USAGE = 'styrby-session-encryption-v1';

/**
 * Nonce length for TweetNaCl secretbox (24 bytes).
 */
const NONCE_LENGTH = nacl.secretbox.nonceLength; // 24

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive a symmetric encryption key for a specific session.
 *
 * The key is derived from the user's master secret and bound to both
 * the session ID and machine ID, ensuring:
 * - Different sessions have different keys (compartmentalization)
 * - Only the owning machine can decrypt (device binding)
 *
 * @param context - Key derivation context
 * @returns 32-byte symmetric key for TweetNaCl secretbox
 *
 * @example
 * const key = await deriveSessionKey({
 *   userSecret: secretBytes,
 *   sessionId: 'uuid-session-id',
 *   machineId: 'uuid-machine-id',
 * });
 */
export async function deriveSessionKey(context: KeyContext): Promise<Uint8Array> {
  // Derive key with path: [sessionId, machineId]
  // This creates unique keys per session per machine
  return deriveKey(context.userSecret, KEY_USAGE, [context.sessionId, context.machineId]);
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypt a message for storage.
 *
 * Uses TweetNaCl secretbox (XSalsa20-Poly1305) which provides:
 * - Authenticated encryption (integrity + confidentiality)
 * - Random nonce generation for each message
 *
 * @param plaintext - Message content to encrypt
 * @param key - 32-byte symmetric encryption key
 * @returns Encrypted payload with ciphertext and nonce
 * @throws {Error} If encryption fails
 *
 * @example
 * const encrypted = encryptMessage('Hello, world!', sessionKey);
 * // Store encrypted.contentEncrypted and encrypted.nonce in database
 */
export function encryptMessage(plaintext: string, key: Uint8Array): EncryptedPayload {
  // Generate random nonce
  const nonce = nacl.randomBytes(NONCE_LENGTH);

  // Convert plaintext to bytes
  const plaintextBytes = new TextEncoder().encode(plaintext);

  // Encrypt
  const ciphertext = nacl.secretbox(plaintextBytes, nonce, key);

  if (!ciphertext) {
    throw new Error('Encryption failed: secretbox returned null');
  }

  return {
    contentEncrypted: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
  };
}

/**
 * Decrypt a stored message.
 *
 * Verifies the authentication tag before returning plaintext.
 * Throws if the message has been tampered with.
 *
 * @param payload - Encrypted payload from storage
 * @param key - 32-byte symmetric encryption key
 * @returns Decrypted plaintext
 * @throws {Error} If decryption fails (wrong key or tampered data)
 *
 * @example
 * const plaintext = decryptMessage({
 *   contentEncrypted: storedCiphertext,
 *   nonce: storedNonce,
 * }, sessionKey);
 */
export function decryptMessage(payload: EncryptedPayload, key: Uint8Array): string {
  // Decode from base64
  const ciphertext = decodeBase64(payload.contentEncrypted);
  const nonce = decodeBase64(payload.nonce);

  // Decrypt
  const plaintextBytes = nacl.secretbox.open(ciphertext, nonce, key);

  if (!plaintextBytes) {
    throw new Error('Decryption failed: invalid key or tampered data');
  }

  return new TextDecoder().decode(plaintextBytes);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a payload appears to be encrypted.
 *
 * Simple validation that the payload has the expected structure.
 * Does not verify the encryption is valid.
 *
 * @param payload - Object to check
 * @returns True if payload has encryption structure
 */
export function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const p = payload as Record<string, unknown>;
  return typeof p.contentEncrypted === 'string' && typeof p.nonce === 'string';
}

/**
 * Generate a new random encryption key.
 *
 * Used for testing or when creating ephemeral encryption.
 * In production, always use deriveSessionKey instead.
 *
 * @returns 32-byte random key
 */
export function generateRandomKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

export default {
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  isEncryptedPayload,
  generateRandomKey,
};
