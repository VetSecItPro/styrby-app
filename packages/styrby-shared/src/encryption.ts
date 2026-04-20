/**
 * Styrby E2E Encryption Module (libsodium)
 *
 * Provides public-key authenticated encryption (Curve25519 + XSalsa20-Poly1305
 * via crypto_box) for messages exchanged between CLI and mobile devices via
 * Supabase Realtime.
 *
 * ## Architecture
 * - Each device (CLI machine + mobile) generates a keypair
 * - Public keys are exchanged during pairing and stored in `machine_keys`
 * - Messages are encrypted with the sender's secret + recipient's public key
 * - Only the intended recipient can decrypt using their secret + sender's public key
 *
 * ## WHY libsodium over TweetNaCl
 * - Actively maintained (TweetNaCl has been frozen since 2019)
 * - Constant-time guarantees in the underlying C core
 * - Enables XChaCha20-Poly1305 and other extended primitives for future features
 *   (see encryptStream/decryptStream below)
 * - Byte-for-byte wire compatible with existing TweetNaCl-encrypted data
 *   (see tests/encryption-compat.test.ts)
 *
 * ## WHY the API is async
 * libsodium is WebAssembly. The WASM module must be compiled and loaded
 * before any crypto function runs. That is an inherently asynchronous
 * operation. Hiding it behind a sync facade would either (a) require a
 * manual init step that callers forget until a user session crashes, or
 * (b) ship a 3x-larger sync-only build. Making every exported function
 * `async` keeps the contract honest and lets TypeScript force callers to
 * handle the single await.
 *
 * ## Cipher choices
 * | Primitive  | Use case                              | Standard                    |
 * |------------|---------------------------------------|-----------------------------|
 * | crypto_box | E2E messages (default)                | NaCl box (Curve25519+XSalsa20-Poly1305) |
 * | XChaCha20  | Streaming / large payloads (future)   | RFC 8439 + 192-bit nonce ext |
 *
 * @module encryption
 */

import sodium from 'libsodium-wrappers';

// ============================================================================
// Types
// ============================================================================

/**
 * A public-key authenticated encryption keypair (Curve25519).
 *
 * Name kept as NaClKeyPair for source-compat with callers that already
 * import the type. The underlying primitive is the same - libsodium's
 * crypto_box IS the NaCl box primitive.
 */
export interface NaClKeyPair {
  /** The public key (32 bytes) - safe to share and store remotely */
  publicKey: Uint8Array;
  /** The secret key (32 bytes) - must never leave the device */
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
   * WHY: crypto_box requires a unique nonce per message. Reusing a nonce
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
// Initialization
// ============================================================================

/**
 * Ensures libsodium's WASM module is loaded before any crypto call runs.
 *
 * WHY: libsodium-wrappers loads its WASM lazily on first `sodium.ready` await.
 * Every public function below calls this first to guarantee the module is
 * initialized even if the caller never explicitly awaits it. Subsequent
 * awaits resolve immediately (the promise is cached inside libsodium).
 *
 * @returns Resolves when libsodium is ready to use
 */
async function ensureReady(): Promise<void> {
  await sodium.ready;
}

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generates a new Curve25519 keypair for public-key authenticated encryption.
 *
 * WHY box (not secretbox): We need two-party encryption where each party
 * has their own keypair. The resulting keys use Curve25519 for DH key
 * exchange, XSalsa20 for encryption, and Poly1305 for authentication.
 *
 * @returns A new keypair with 32-byte public and secret keys
 *
 * @example
 * const keypair = await generateKeyPair();
 * // Store keypair.secretKey securely (SecureStore on mobile)
 * // Upload keypair.publicKey to machine_keys table
 */
export async function generateKeyPair(): Promise<NaClKeyPair> {
  await ensureReady();
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.privateKey,
  };
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypts a plaintext message using public-key authenticated encryption
 * (crypto_box: Curve25519 + XSalsa20-Poly1305).
 *
 * The message is encrypted such that only the holder of the recipient's
 * secret key can decrypt it, and the recipient can verify it was sent by
 * the holder of the sender's secret key.
 *
 * @param message - The plaintext string to encrypt
 * @param recipientPublicKey - The recipient's public key (32 bytes)
 * @param senderSecretKey - The sender's secret key (32 bytes)
 * @returns The encrypted payload containing ciphertext and nonce
 * @throws {Error} If encryption fails (invalid keys, empty message)
 *
 * @example
 * const result = await encrypt('Hello!', cliPublicKey, mobileSecretKey);
 * // Store result.encrypted as content_encrypted, result.nonce as encryption_nonce
 */
export async function encrypt(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): Promise<EncryptedPayload> {
  await ensureReady();

  if (!message) {
    throw new Error('Cannot encrypt empty message');
  }

  if (recipientPublicKey.length !== 32) {
    throw new Error(
      `Invalid recipient public key length: expected 32, got ${recipientPublicKey.length}`,
    );
  }

  if (senderSecretKey.length !== 32) {
    throw new Error(
      `Invalid sender secret key length: expected 32, got ${senderSecretKey.length}`,
    );
  }

  // WHY a fresh random nonce per message: crypto_box nonces are 24 bytes.
  // Reusing a nonce with the same keypair would allow an attacker to
  // recover the shared key (XSalsa20 becomes a two-time pad).
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const messageBytes = sodium.from_string(message);

  const encrypted = sodium.crypto_box_easy(
    messageBytes,
    nonce,
    recipientPublicKey,
    senderSecretKey,
  );

  return { encrypted, nonce };
}

// ============================================================================
// Decryption
// ============================================================================

/**
 * Decrypts a crypto_box encrypted message.
 *
 * @param encrypted - The ciphertext to decrypt
 * @param nonce - The nonce that was used during encryption (24 bytes)
 * @param senderPublicKey - The sender's public key (32 bytes)
 * @param recipientSecretKey - The recipient's secret key (32 bytes)
 * @returns The decrypted plaintext string
 * @throws {Error} If decryption fails (wrong keys, tampered ciphertext, invalid nonce)
 *
 * @example
 * const plaintext = await decrypt(encrypted, nonce, mobilePublicKey, cliSecretKey);
 */
export async function decrypt(
  encrypted: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Promise<string> {
  await ensureReady();

  if (nonce.length !== sodium.crypto_box_NONCEBYTES) {
    throw new Error(
      `Invalid nonce length: expected ${sodium.crypto_box_NONCEBYTES}, got ${nonce.length}`,
    );
  }

  if (senderPublicKey.length !== 32) {
    throw new Error(
      `Invalid sender public key length: expected 32, got ${senderPublicKey.length}`,
    );
  }

  if (recipientSecretKey.length !== 32) {
    throw new Error(
      `Invalid recipient secret key length: expected 32, got ${recipientSecretKey.length}`,
    );
  }

  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = sodium.crypto_box_open_easy(
      encrypted,
      nonce,
      senderPublicKey,
      recipientSecretKey,
    );
  } catch {
    throw new Error('Decryption failed: invalid ciphertext, wrong keys, or tampered message');
  }

  return sodium.to_string(plaintextBytes);
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
 * @returns Base64-encoded string (original variant, with padding)
 */
export async function encodeBase64(bytes: Uint8Array): Promise<string> {
  await ensureReady();
  // WHY base64_variants.ORIGINAL: matches tweetnacl-util's output (standard
  // base64 with padding, e.g. "AAAA" or "AAA="). Without this, libsodium
  // defaults to URL-safe variant without padding and breaks existing rows.
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/**
 * Decodes a base64 string back to a Uint8Array.
 *
 * @param base64 - The base64-encoded string to decode
 * @returns The decoded byte array
 * @throws {Error} If the input is not valid base64
 */
export async function decodeBase64(base64: string): Promise<Uint8Array> {
  await ensureReady();
  return sodium.from_base64(base64, sodium.base64_variants.ORIGINAL);
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
 * const { encrypted, nonce } = await encryptForStorage('Hello!', cliPublicKey, mobileSecretKey);
 * await supabase.from('session_messages').insert({
 *   content_encrypted: encrypted,
 *   encryption_nonce: nonce,
 * });
 */
export async function encryptForStorage(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): Promise<EncryptedPayloadBase64> {
  const { encrypted, nonce } = await encrypt(message, recipientPublicKey, senderSecretKey);
  return {
    encrypted: await encodeBase64(encrypted),
    nonce: await encodeBase64(nonce),
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
 */
export async function decryptFromStorage(
  encryptedBase64: string,
  nonceBase64: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Promise<string> {
  const encrypted = await decodeBase64(encryptedBase64);
  const nonce = await decodeBase64(nonceBase64);
  return decrypt(encrypted, nonce, senderPublicKey, recipientSecretKey);
}

/**
 * Generates a fingerprint (first 16 hex chars of SHA-256 hash) for a public key.
 * Used for visual key verification and stored in the `machine_keys.fingerprint` column.
 *
 * WHY: The fingerprint allows users to verify they are communicating with the
 * correct device by comparing short strings instead of full 32-byte keys.
 *
 * @param publicKey - The public key (32 bytes)
 * @returns A 16-character hex string fingerprint
 */
export async function generateFingerprint(publicKey: Uint8Array): Promise<string> {
  // WHY: Explicit ArrayBuffer cast avoids TS2345 with Uint8Array<ArrayBufferLike>
  // in strict TypeScript 5.9+ where SharedArrayBuffer is not assignable to ArrayBuffer.
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    publicKey as Uint8Array<ArrayBuffer>,
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// XChaCha20-Poly1305 (extended-nonce AEAD) — for streaming / large payloads
// ============================================================================

/**
 * XChaCha20-Poly1305 nonce length (24 bytes / 192 bits).
 * WHY exposed: Callers generating nonces for streaming upload need this.
 */
export const XCHACHA20_NONCE_BYTES = 24;

/**
 * XChaCha20-Poly1305 key length (32 bytes).
 */
export const XCHACHA20_KEY_BYTES = 32;

/**
 * Encrypts a plaintext with XChaCha20-Poly1305 (extended-nonce AEAD).
 *
 * WHY XChaCha20 over crypto_secretbox:
 * - 192-bit nonce (vs 192-bit for secretbox too, but XChaCha20's construction
 *   is explicitly designed to support random nonces for trillions of messages
 *   without collision anxiety)
 * - Supports additional authenticated data (AAD) for binding ciphertext to
 *   metadata like session_id, message_id, or file checksums without
 *   including them in the encrypted payload
 * - Standardized in RFC 8439 (ChaCha20) + libsodium XChaCha20 extension
 *
 * Intended future use cases:
 * - E2E-encrypted file attachments in session messages
 * - Large-payload streaming where plaintext exceeds a single network buffer
 * - Any context needing AAD binding (e.g. checkpointed session chunks)
 *
 * @param plaintext - The bytes to encrypt (Uint8Array - supports binary, not just strings)
 * @param key - Symmetric key (32 bytes, generate via crypto.getRandomValues or KDF)
 * @param additionalData - Optional AAD that must match at decrypt time; not encrypted
 *                        but authenticated (e.g. a message UUID binding this ciphertext)
 * @returns `{ ciphertext, nonce }` where nonce is 24 bytes of fresh randomness
 * @throws {Error} If the key length is invalid
 *
 * @example
 * const key = sodium.randombytes_buf(XCHACHA20_KEY_BYTES);
 * const fileBytes = new Uint8Array(await file.arrayBuffer());
 * const { ciphertext, nonce } = await encryptStream(fileBytes, key, new TextEncoder().encode(messageId));
 */
export async function encryptStream(
  plaintext: Uint8Array,
  key: Uint8Array,
  additionalData?: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  await ensureReady();

  if (key.length !== XCHACHA20_KEY_BYTES) {
    throw new Error(
      `Invalid key length: expected ${XCHACHA20_KEY_BYTES}, got ${key.length}`,
    );
  }

  const nonce = sodium.randombytes_buf(XCHACHA20_NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    additionalData ?? null,
    null, // secret nonce - unused in this AEAD
    nonce,
    key,
  );

  return { ciphertext, nonce };
}

/**
 * Decrypts an XChaCha20-Poly1305 ciphertext produced by encryptStream().
 *
 * @param ciphertext - The encrypted bytes
 * @param nonce - The 24-byte nonce that was used during encryption
 * @param key - The same symmetric key used during encryption
 * @param additionalData - The same AAD that was provided to encryptStream,
 *                         or undefined if none was used. Must match exactly
 *                         or decryption fails.
 * @returns The decrypted plaintext bytes
 * @throws {Error} If authentication fails (wrong key, tampered ciphertext, AAD mismatch)
 */
export async function decryptStream(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();

  if (nonce.length !== XCHACHA20_NONCE_BYTES) {
    throw new Error(
      `Invalid nonce length: expected ${XCHACHA20_NONCE_BYTES}, got ${nonce.length}`,
    );
  }

  if (key.length !== XCHACHA20_KEY_BYTES) {
    throw new Error(
      `Invalid key length: expected ${XCHACHA20_KEY_BYTES}, got ${key.length}`,
    );
  }

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // secret nonce - unused
      ciphertext,
      additionalData ?? null,
      nonce,
      key,
    );
  } catch {
    throw new Error(
      'Stream decryption failed: invalid ciphertext, wrong key, nonce, or AAD mismatch',
    );
  }
}
