/**
 * Local at-rest encryption for on-device data (SEC-MOB-001).
 *
 * The offline command queue persists user command payloads to local SQLite.
 * Those rows are gated by OS app-sandboxing, but on a jailbroken/rooted device
 * or an unencrypted backup they would be readable as plaintext. This module
 * encrypts such payloads at rest with a device-local symmetric key (XChaCha20-
 * Poly1305 AEAD, 256-bit key from the OS CSPRNG, fresh 192-bit nonce per value)
 * held in the OS keychain via expo-secure-store.
 *
 * It is transparent to callers: encrypt on write, decrypt on read. Decryption
 * is backward-compatible — rows written before this module shipped (raw JSON)
 * are detected by the absence of the version tag and passed through unchanged,
 * so no destructive migration is required.
 *
 * @module services/at-rest
 */

import * as SecureStore from 'expo-secure-store';
import 'react-native-get-random-values'; // polyfills crypto.getRandomValues on RN
import {
  encryptStream,
  decryptStream,
  encodeBase64,
  decodeBase64,
  XCHACHA20_KEY_BYTES,
} from 'styrby-shared/encryption';

/** SecureStore key for the device-local at-rest symmetric key (base64). */
const AT_REST_KEY_STORAGE = 'styrby_atrest_key';

/**
 * Version tag prefixing every ciphertext blob. Lets decryptAtRest distinguish a
 * v1 ciphertext from a legacy raw-JSON payload (which starts with `{`/`[`).
 */
const TAG = 'sqar1.';

let cachedKey: Uint8Array | null = null;

/**
 * Get (or lazily create) the device-local 32-byte at-rest key from the OS
 * keychain. Generated with the OS CSPRNG on first use.
 *
 * @returns The 32-byte symmetric key.
 */
async function getOrCreateAtRestKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  const existing = await SecureStore.getItemAsync(AT_REST_KEY_STORAGE);
  if (existing) {
    cachedKey = await decodeBase64(existing);
    return cachedKey;
  }
  const key = new Uint8Array(XCHACHA20_KEY_BYTES);
  crypto.getRandomValues(key);
  // SEC-MOB-005: device-bound — never sync this at-rest key to cloud backup.
  await SecureStore.setItemAsync(AT_REST_KEY_STORAGE, await encodeBase64(key), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cachedKey = key;
  return key;
}

/**
 * Encrypt a UTF-8 string for at-rest storage.
 *
 * @param plaintext - The string to encrypt (e.g. a JSON command payload).
 * @returns A tagged, base64 blob: `sqar1.<nonceB64>.<ciphertextB64>`.
 */
export async function encryptAtRest(plaintext: string): Promise<string> {
  const key = await getOrCreateAtRestKey();
  const { ciphertext, nonce } = await encryptStream(new TextEncoder().encode(plaintext), key);
  return `${TAG}${await encodeBase64(nonce)}.${await encodeBase64(ciphertext)}`;
}

/**
 * Decrypt a blob produced by encryptAtRest. Backward-compatible: a value that
 * does not carry the version tag is assumed to be legacy plaintext and returned
 * unchanged (so pre-existing rows keep working without a migration).
 *
 * @param blob - The stored value (tagged ciphertext or legacy plaintext).
 * @returns The decrypted UTF-8 string (or the input verbatim if untagged).
 */
export async function decryptAtRest(blob: string): Promise<string> {
  if (!blob.startsWith(TAG)) return blob; // legacy plaintext row — passthrough
  const [nonceB64, cipherB64] = blob.slice(TAG.length).split('.');
  if (!nonceB64 || !cipherB64) return blob; // malformed; do not throw on read
  const key = await getOrCreateAtRestKey();
  const plaintext = await decryptStream(await decodeBase64(cipherB64), await decodeBase64(nonceB64), key);
  return new TextDecoder().decode(plaintext);
}

/**
 * Delete the device at-rest key (SEC-MOB-002 account-deletion wipe). After this,
 * any remaining tagged rows become permanently undecryptable — which is the
 * intent on account deletion. Clears the in-memory cache too.
 */
export async function clearAtRestKey(): Promise<void> {
  await SecureStore.deleteItemAsync(AT_REST_KEY_STORAGE);
  cachedKey = null;
}
