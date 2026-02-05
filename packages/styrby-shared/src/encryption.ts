/**
 * Styrby E2E Encryption Module
 *
 * Provides NaCl box (public-key authenticated encryption) for encrypting
 * messages between CLI and mobile devices via Supabase Realtime.
 *
 * Architecture:
 * - Each device (CLI machine + mobile) generates a NaCl keypair
 * - Public keys are exchanged during pairing and stored in `machine_keys`
 * - Messages are encrypted with the sender's secret key + recipient's public key
 * - Only the intended recipient can decrypt using their secret key + sender's public key
 *
 * WHY NaCl box: It provides both confidentiality (encryption) and authenticity
 * (the recipient can verify the sender). This is critical because Supabase Realtime
 * messages pass through Supabase servers -- E2E encryption ensures the server
 * (and any attacker with server access) cannot read message content.
 *
 * Dependencies: tweetnacl, tweetnacl-util
 * These must be added to the package.json of any package importing this module.
 */

import nacl from 'tweetnacl';
import { encodeBase64 as naclEncodeBase64, decodeBase64 as naclDecodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

// ============================================================================
// Types
// ============================================================================

/**
 * A NaCl box keypair for public-key authenticated encryption.
 * The public key is shared with communication partners; the secret key
 * is stored securely on-device and never transmitted.
 */
export interface NaClKeyPair {
  /** The public key (32 bytes) -- safe to share and store remotely */
  publicKey: Uint8Array;
  /** The secret key (32 bytes) -- must never leave the device */
  secretKey: Uint8Array;
}

/**
 * Result of encrypting a message, containing the ciphertext and the nonce
 * used for encryption. Both are needed for decryption.
 */
export interface EncryptedPayload {
  /** The encrypted ciphertext (variable length) */
  encrypted: Uint8Array;
  /**
   * The random nonce used for this encryption (24 bytes).
   * WHY: NaCl box requires a unique nonce per message. Reusing a nonce
   * with the same keypair completely breaks the encryption.
   */
  nonce: Uint8Array;
}

/**
 * Base64-encoded version of EncryptedPayload for storage in Supabase
 * text columns and JSON serialization over the relay.
 */
export interface EncryptedPayloadBase64 {
  /** Base64-encoded ciphertext */
  encrypted: string;
  /** Base64-encoded nonce */
  nonce: string;
}

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generates a new NaCl box keypair for public-key authenticated encryption.
 *
 * WHY box (not secretbox): We need two-party encryption where each party
 * has their own keypair. NaCl box uses Curve25519 for key exchange,
 * XSalsa20 for encryption, and Poly1305 for authentication.
 *
 * @returns A new keypair with 32-byte public and secret keys
 *
 * @example
 * const keypair = generateKeyPair();
 * // Store keypair.secretKey securely (SecureStore on mobile)
 * // Upload keypair.publicKey to machine_keys table
 */
export function generateKeyPair(): NaClKeyPair {
  const keypair = nacl.box.keyPair();
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
  };
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypts a plaintext message using NaCl box (public-key authenticated encryption).
 *
 * The message is encrypted such that only the holder of the recipient's secret key
 * can decrypt it, and the recipient can verify it was sent by the holder of the
 * sender's secret key.
 *
 * @param message - The plaintext string to encrypt
 * @param recipientPublicKey - The recipient's NaCl box public key (32 bytes)
 * @param senderSecretKey - The sender's NaCl box secret key (32 bytes)
 * @returns The encrypted payload containing ciphertext and nonce
 * @throws {Error} If encryption fails (invalid keys, empty message)
 *
 * @example
 * const result = encrypt('Hello from mobile!', cliPublicKey, mobileSecretKey);
 * // Store result.encrypted and result.nonce in session_messages
 */
export function encrypt(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array
): EncryptedPayload {
  if (!message) {
    throw new Error('Cannot encrypt empty message');
  }

  if (recipientPublicKey.length !== 32) {
    throw new Error(`Invalid recipient public key length: expected 32, got ${recipientPublicKey.length}`);
  }

  if (senderSecretKey.length !== 32) {
    throw new Error(`Invalid sender secret key length: expected 32, got ${senderSecretKey.length}`);
  }

  // WHY: A fresh random nonce per message is critical for security.
  // NaCl nonces are 24 bytes. Reusing a nonce with the same keypair
  // would allow an attacker to recover the shared key.
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageUint8 = decodeUTF8(message);

  const encrypted = nacl.box(messageUint8, nonce, recipientPublicKey, senderSecretKey);

  if (!encrypted) {
    throw new Error('Encryption failed');
  }

  return { encrypted, nonce };
}

// ============================================================================
// Decryption
// ============================================================================

/**
 * Decrypts a NaCl box encrypted message.
 *
 * @param encrypted - The ciphertext to decrypt
 * @param nonce - The nonce that was used during encryption (24 bytes)
 * @param senderPublicKey - The sender's NaCl box public key (32 bytes)
 * @param recipientSecretKey - The recipient's NaCl box secret key (32 bytes)
 * @returns The decrypted plaintext string
 * @throws {Error} If decryption fails (wrong keys, tampered ciphertext, invalid nonce)
 *
 * @example
 * const plaintext = decrypt(encryptedData, nonce, mobilePublicKey, cliSecretKey);
 */
export function decrypt(
  encrypted: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): string {
  if (nonce.length !== nacl.box.nonceLength) {
    throw new Error(`Invalid nonce length: expected ${nacl.box.nonceLength}, got ${nonce.length}`);
  }

  if (senderPublicKey.length !== 32) {
    throw new Error(`Invalid sender public key length: expected 32, got ${senderPublicKey.length}`);
  }

  if (recipientSecretKey.length !== 32) {
    throw new Error(`Invalid recipient secret key length: expected 32, got ${recipientSecretKey.length}`);
  }

  const decrypted = nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);

  if (!decrypted) {
    throw new Error('Decryption failed: invalid ciphertext, wrong keys, or tampered message');
  }

  return encodeUTF8(decrypted);
}

// ============================================================================
// Base64 Encoding
// ============================================================================

/**
 * Encodes a Uint8Array to a base64 string for storage in text columns.
 *
 * WHY: Supabase text columns and JSON payloads cannot store raw bytes.
 * Base64 encoding converts binary data to ASCII with ~33% overhead,
 * which is acceptable for message-sized payloads.
 *
 * @param bytes - The byte array to encode
 * @returns Base64-encoded string
 */
export function encodeBase64(bytes: Uint8Array): string {
  return naclEncodeBase64(bytes);
}

/**
 * Decodes a base64 string back to a Uint8Array.
 *
 * @param base64 - The base64-encoded string to decode
 * @returns The decoded byte array
 * @throws {Error} If the input is not valid base64
 */
export function decodeBase64(base64: string): Uint8Array {
  return naclDecodeBase64(base64);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Encrypts a message and returns base64-encoded result for database storage.
 * Combines encrypt() + encodeBase64() into a single call.
 *
 * @param message - The plaintext string to encrypt
 * @param recipientPublicKey - The recipient's public key (32 bytes)
 * @param senderSecretKey - The sender's secret key (32 bytes)
 * @returns Base64-encoded encrypted payload ready for Supabase columns
 *
 * @example
 * const { encrypted, nonce } = encryptForStorage('Hello!', cliPublicKey, mobileSecretKey);
 * await supabase.from('session_messages').insert({
 *   encrypted_content: encrypted,
 *   nonce: nonce,
 *   content: null,
 * });
 */
export function encryptForStorage(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array
): EncryptedPayloadBase64 {
  const { encrypted, nonce } = encrypt(message, recipientPublicKey, senderSecretKey);
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

/**
 * Decrypts a base64-encoded encrypted payload from database storage.
 * Combines decodeBase64() + decrypt() into a single call.
 *
 * @param encryptedBase64 - Base64-encoded ciphertext from database
 * @param nonceBase64 - Base64-encoded nonce from database
 * @param senderPublicKey - The sender's public key (32 bytes)
 * @param recipientSecretKey - The recipient's secret key (32 bytes)
 * @returns The decrypted plaintext string
 * @throws {Error} If decryption fails
 *
 * @example
 * const plaintext = decryptFromStorage(
 *   row.encrypted_content,
 *   row.nonce,
 *   cliPublicKey,
 *   mobileSecretKey
 * );
 */
export function decryptFromStorage(
  encryptedBase64: string,
  nonceBase64: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): string {
  const encrypted = decodeBase64(encryptedBase64);
  const nonce = decodeBase64(nonceBase64);
  return decrypt(encrypted, nonce, senderPublicKey, recipientSecretKey);
}

/**
 * Generates a fingerprint (first 16 hex chars of SHA-256 hash) for a public key.
 * Used for visual key verification and stored in the `machine_keys.fingerprint` column.
 *
 * WHY: The fingerprint allows users to verify they are communicating with the
 * correct device by comparing short strings instead of full 32-byte keys.
 *
 * @param publicKey - The NaCl box public key (32 bytes)
 * @returns A 16-character hex string fingerprint
 */
export async function generateFingerprint(publicKey: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', publicKey);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
