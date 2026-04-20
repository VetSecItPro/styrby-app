/**
 * Session Message Encryption (libsodium)
 *
 * Provides at-rest encryption for session messages. Messages are encrypted
 * before being stored in Supabase, ensuring the server never sees plaintext.
 *
 * ## Encryption Scheme
 *
 * - Algorithm: XSalsa20-Poly1305 (libsodium crypto_secretbox — same primitive
 *   as TweetNaCl's nacl.secretbox, byte-for-byte wire compatible)
 * - Key derivation: HMAC-SHA512 from user seed + session context (unchanged)
 * - Nonce: Random 24 bytes per message (stored alongside ciphertext)
 *
 * ## Security Properties
 *
 * - Compartmentalization: Each session + machine pair gets a unique derived key
 * - Authenticated encryption: Tampering is detected (Poly1305 MAC)
 * - Random nonces: Safe to reuse key across messages (XSalsa20's 192-bit nonce
 *   makes collisions cryptographically impossible at realistic volumes)
 *
 * ## WHY libsodium
 *
 * Matches the migration already done in @styrby/shared. Same primitive, same
 * byte output as TweetNaCl — existing encrypted session messages decrypt
 * unchanged. Full rationale in packages/styrby-shared/src/encryption.ts.
 *
 * ## WHY async
 *
 * libsodium is WebAssembly; `sodium.ready` must resolve before any crypto
 * call runs. The public API below is async to surface this honestly to
 * callers. All existing callers already live in async code paths.
 *
 * @module session/encryption
 */

import sodium from 'libsodium-wrappers';
import { encode as b64encode, decode as b64decode } from '@stablelib/base64';
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
 * WHY: Changes to this string invalidate all existing encrypted data, so it
 * must remain stable across the libsodium migration. A new "v2" string would
 * silently break every stored message.
 */
const KEY_USAGE = 'styrby-session-encryption-v1';

/**
 * Nonce length for XSalsa20-Poly1305 (24 bytes).
 * Hardcoded rather than reading from sodium constants at import time, since
 * the WASM module is not yet ready at module load.
 */
const NONCE_LENGTH = 24;

/**
 * Symmetric key length for crypto_secretbox (32 bytes).
 */
const KEY_LENGTH = 32;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Ensures libsodium's WASM module is loaded before any crypto call runs.
 * WHY: libsodium-wrappers loads its WASM lazily on first `sodium.ready` await.
 * Subsequent awaits resolve immediately — the promise is cached inside libsodium.
 */
async function ensureReady(): Promise<void> {
  await sodium.ready;
}

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
 * @returns 32-byte symmetric key for crypto_secretbox
 *
 * @example
 * const key = await deriveSessionKey({
 *   userSecret: secretBytes,
 *   sessionId: 'uuid-session-id',
 *   machineId: 'uuid-machine-id',
 * });
 */
export async function deriveSessionKey(context: KeyContext): Promise<Uint8Array> {
  return deriveKey(context.userSecret, KEY_USAGE, [context.sessionId, context.machineId]);
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypt a message for storage.
 *
 * Uses libsodium crypto_secretbox_easy (XSalsa20-Poly1305) which provides:
 * - Authenticated encryption (integrity + confidentiality)
 * - Random nonce generation for each message
 *
 * @param plaintext - Message content to encrypt
 * @param key - 32-byte symmetric encryption key
 * @returns Encrypted payload with ciphertext and nonce (both base64-encoded)
 * @throws {Error} If the key length is invalid
 *
 * @example
 * const encrypted = await encryptMessage('Hello, world!', sessionKey);
 * // Store encrypted.contentEncrypted and encrypted.nonce in database
 */
export async function encryptMessage(
  plaintext: string,
  key: Uint8Array,
): Promise<EncryptedPayload> {
  await ensureReady();

  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`);
  }

  const nonce = sodium.randombytes_buf(NONCE_LENGTH);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = sodium.crypto_secretbox_easy(plaintextBytes, nonce, key);

  return {
    contentEncrypted: b64encode(ciphertext),
    nonce: b64encode(nonce),
  };
}

/**
 * Decrypt a stored message.
 *
 * Verifies the Poly1305 authentication tag before returning plaintext.
 * Throws if the message has been tampered with or the wrong key is used.
 *
 * @param payload - Encrypted payload from storage
 * @param key - 32-byte symmetric encryption key
 * @returns Decrypted plaintext
 * @throws {Error} If decryption fails (wrong key, tampered data, invalid lengths)
 *
 * @example
 * const plaintext = await decryptMessage({
 *   contentEncrypted: storedCiphertext,
 *   nonce: storedNonce,
 * }, sessionKey);
 */
export async function decryptMessage(
  payload: EncryptedPayload,
  key: Uint8Array,
): Promise<string> {
  await ensureReady();

  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`);
  }

  const ciphertext = b64decode(payload.contentEncrypted);
  const nonce = b64decode(payload.nonce);

  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Invalid nonce length: expected ${NONCE_LENGTH}, got ${nonce.length}`);
  }

  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
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
 * Simple structural validation only — does not verify the encryption is valid.
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
 * Generate a new random 32-byte encryption key.
 *
 * Used for testing or ephemeral encryption. In production, always use
 * deriveSessionKey() so the key is bound to the user + session + machine.
 *
 * @returns 32-byte random key
 */
export async function generateRandomKey(): Promise<Uint8Array> {
  await ensureReady();
  return sodium.randombytes_buf(KEY_LENGTH);
}

export default {
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  isEncryptedPayload,
  generateRandomKey,
};
