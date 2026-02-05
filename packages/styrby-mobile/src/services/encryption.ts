/**
 * Mobile Encryption Service
 *
 * Manages E2E encryption keypairs and provides encrypt/decrypt operations
 * for the mobile app. Keypairs are stored in SecureStore (iOS Keychain /
 * Android Keystore) and public keys are synced to the `machine_keys` table
 * in Supabase for key exchange with CLI devices.
 *
 * Architecture:
 * - Mobile generates a NaCl box keypair on first use
 * - The secret key stays on-device in SecureStore (never transmitted)
 * - The public key is uploaded to `machine_keys` during pairing
 * - The CLI's public key is fetched from `machine_keys` and cached in memory
 * - Messages are encrypted with the recipient's public key + sender's secret key
 *
 * WHY SecureStore: Expo SecureStore uses the OS-level secure enclave (iOS Keychain /
 * Android Keystore). This is significantly more secure than AsyncStorage or
 * MMKV for cryptographic key material. The keys are encrypted at rest and
 * protected by the device's lock screen.
 */

import * as SecureStore from 'expo-secure-store';
import {
  generateKeyPair,
  encryptForStorage,
  decryptFromStorage,
  encodeBase64,
  decodeBase64,
  generateFingerprint,
  type NaClKeyPair,
  type EncryptedPayloadBase64,
} from 'styrby-shared';
import { supabase } from '../lib/supabase';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the mobile device's NaCl box keypair.
 * Stores a JSON object with base64-encoded publicKey and secretKey.
 *
 * WHY a single key: SecureStore has a 2048-byte value limit on some platforms.
 * A NaCl keypair serialized as JSON with base64 values is ~130 bytes, well
 * within this limit. Storing as a single key also makes atomic read/write easier.
 */
const KEYPAIR_STORAGE_KEY = 'styrby_encryption_keypair';

// ============================================================================
// Types
// ============================================================================

/**
 * JSON-serializable form of the keypair for SecureStore persistence.
 * Both keys are base64-encoded since SecureStore only stores strings.
 */
interface StoredKeyPair {
  /** Base64-encoded NaCl box public key (32 bytes) */
  publicKey: string;
  /** Base64-encoded NaCl box secret key (32 bytes) */
  secretKey: string;
}

// ============================================================================
// In-Memory Cache
// ============================================================================

/**
 * WHY: Avoid repeated SecureStore reads and Supabase queries for hot-path
 * operations (every message encrypt/decrypt). The cache is populated on
 * first access and lives for the app session.
 */

/** Cached mobile keypair (loaded from SecureStore on first access) */
let cachedKeyPair: NaClKeyPair | null = null;

/**
 * Cached recipient public keys indexed by machine ID.
 * WHY Map: We look up keys by machine_id on every encrypt/decrypt call.
 * A Map gives O(1) lookup vs repeated Supabase queries.
 */
const recipientKeyCache = new Map<string, Uint8Array>();

// ============================================================================
// Dev Logger
// ============================================================================

/**
 * Development-only logger that suppresses output in production.
 * WHY: Prevents cryptographic key material references from appearing
 * in production logs. Only fingerprints are logged, never raw keys.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Encryption]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Encryption]', ...args); },
};

// ============================================================================
// Key Management
// ============================================================================

/**
 * Retrieves the existing keypair from SecureStore, or generates a new one
 * if none exists. The keypair is cached in memory for the app session.
 *
 * This is the primary entry point for getting the mobile device's keypair.
 * It handles the full lifecycle: check cache -> check SecureStore -> generate.
 *
 * @returns The mobile device's NaCl box keypair
 * @throws {Error} If SecureStore read/write fails
 *
 * @example
 * const keypair = await getOrCreateKeyPair();
 * // keypair.publicKey is safe to upload to machine_keys
 * // keypair.secretKey stays on-device
 */
export async function getOrCreateKeyPair(): Promise<NaClKeyPair> {
  // Check in-memory cache first (hot path)
  if (cachedKeyPair) {
    return cachedKeyPair;
  }

  // Check SecureStore for a persisted keypair
  const stored = await SecureStore.getItemAsync(KEYPAIR_STORAGE_KEY);

  if (stored) {
    try {
      const parsed: StoredKeyPair = JSON.parse(stored);
      const keypair: NaClKeyPair = {
        publicKey: decodeBase64(parsed.publicKey),
        secretKey: decodeBase64(parsed.secretKey),
      };

      // Validate key lengths before caching
      if (keypair.publicKey.length !== 32 || keypair.secretKey.length !== 32) {
        logger.error('Stored keypair has invalid key lengths, regenerating');
        return await regenerateKeyPair();
      }

      cachedKeyPair = keypair;
      logger.log('Loaded existing keypair from SecureStore');
      return keypair;
    } catch (parseError) {
      // WHY: If the stored data is corrupted, generate a fresh keypair
      // rather than failing. The old public key in machine_keys will be
      // overwritten during the next pairing or registerPublicKey call.
      logger.error('Failed to parse stored keypair, regenerating:', parseError);
      return await regenerateKeyPair();
    }
  }

  // No stored keypair -- generate a new one
  return await regenerateKeyPair();
}

/**
 * Generates a new keypair and persists it to SecureStore.
 * This replaces any existing keypair.
 *
 * WHY: Called when no keypair exists (first launch) or when the stored
 * keypair is corrupted. After calling this, the public key must be
 * re-uploaded to machine_keys via registerPublicKey().
 *
 * @returns The newly generated keypair
 * @throws {Error} If SecureStore write fails
 */
async function regenerateKeyPair(): Promise<NaClKeyPair> {
  const keypair = generateKeyPair();

  const storedData: StoredKeyPair = {
    publicKey: encodeBase64(keypair.publicKey),
    secretKey: encodeBase64(keypair.secretKey),
  };

  await SecureStore.setItemAsync(KEYPAIR_STORAGE_KEY, JSON.stringify(storedData));

  cachedKeyPair = keypair;
  logger.log('Generated and stored new keypair');

  return keypair;
}

/**
 * Fetches the public key of a recipient (CLI machine) from the `machine_keys`
 * table. Results are cached in memory for the app session.
 *
 * @param machineId - The UUID of the CLI machine to look up
 * @returns The recipient's NaCl box public key (32 bytes)
 * @throws {Error} If the machine has no registered public key or the query fails
 *
 * @example
 * const cliPublicKey = await getRecipientPublicKey(pairingInfo.machineId);
 */
export async function getRecipientPublicKey(machineId: string): Promise<Uint8Array> {
  // Check in-memory cache first
  const cached = recipientKeyCache.get(machineId);
  if (cached) {
    return cached;
  }

  // Query the machine_keys table
  const { data, error } = await supabase
    .from('machine_keys')
    .select('public_key')
    .eq('machine_id', machineId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch public key for machine ${machineId}: ${error.message}`);
  }

  if (!data || !data.public_key) {
    throw new Error(
      `No public key found for machine ${machineId}. ` +
      'The CLI may not have completed key registration. Try re-pairing.'
    );
  }

  const publicKey = decodeBase64(data.public_key);

  if (publicKey.length !== 32) {
    throw new Error(
      `Invalid public key length for machine ${machineId}: ` +
      `expected 32 bytes, got ${publicKey.length}`
    );
  }

  // Cache for future lookups
  recipientKeyCache.set(machineId, publicKey);
  logger.log(`Cached public key for machine ${machineId}`);

  return publicKey;
}

// ============================================================================
// Encrypt / Decrypt
// ============================================================================

/**
 * Encrypts a message for a specific CLI machine.
 * Uses the mobile's secret key and the CLI's public key.
 *
 * @param content - The plaintext message content to encrypt
 * @param machineId - The UUID of the target CLI machine
 * @returns Base64-encoded encrypted content and nonce for database storage
 * @throws {Error} If encryption fails, keypair is unavailable, or CLI key is not found
 *
 * @example
 * const { encrypted, nonce } = await encryptMessage('Hello CLI!', pairingInfo.machineId);
 * // Store in session_messages: encrypted_content = encrypted, nonce = nonce
 */
export async function encryptMessage(
  content: string,
  machineId: string
): Promise<EncryptedPayloadBase64> {
  const keypair = await getOrCreateKeyPair();
  const recipientPublicKey = await getRecipientPublicKey(machineId);

  return encryptForStorage(content, recipientPublicKey, keypair.secretKey);
}

/**
 * Decrypts a message from a specific CLI machine.
 * Uses the CLI's public key and the mobile's secret key.
 *
 * @param encrypted - Base64-encoded ciphertext from database
 * @param nonce - Base64-encoded nonce from database
 * @param machineId - The UUID of the CLI machine that sent the message
 * @returns The decrypted plaintext string
 * @throws {Error} If decryption fails (wrong keys, tampered message, corrupted data)
 *
 * @example
 * try {
 *   const plaintext = await decryptMessage(row.encrypted_content, row.nonce, machineId);
 * } catch {
 *   // Show "[Unable to decrypt]" placeholder
 * }
 */
export async function decryptMessage(
  encrypted: string,
  nonce: string,
  machineId: string
): Promise<string> {
  const keypair = await getOrCreateKeyPair();
  const senderPublicKey = await getRecipientPublicKey(machineId);

  // WHY: senderPublicKey is also fetched via getRecipientPublicKey because
  // both directions use the same machine_keys table. When the CLI encrypts
  // a message for us, it uses its own secret key + our public key.
  // To decrypt, we need the CLI's public key + our secret key.
  return decryptFromStorage(encrypted, nonce, senderPublicKey, keypair.secretKey);
}

// ============================================================================
// Key Registration
// ============================================================================

/**
 * Uploads the mobile device's public key to the `machine_keys` table.
 * Uses upsert to handle both initial registration and key rotation.
 *
 * WHY: The mobile device needs a record in the `machines` table to store its
 * public key in `machine_keys` (foreign key constraint). We use a synthetic
 * machine_id format `mobile_{userId}` to represent the mobile device since
 * it is not a traditional "machine" like a CLI workstation.
 *
 * The machine record is created if it does not exist, then the public key
 * is upserted into machine_keys.
 *
 * @param userId - The authenticated user's UUID
 * @returns void
 * @throws {Error} If the machine or key record cannot be created/updated
 *
 * @example
 * // Called during pairing after QR code validation:
 * await registerPublicKey(user.id);
 */
export async function registerPublicKey(userId: string): Promise<void> {
  const keypair = await getOrCreateKeyPair();
  const publicKeyBase64 = encodeBase64(keypair.publicKey);
  const fingerprint = await generateFingerprint(keypair.publicKey);

  // Step 1: Ensure a machine record exists for the mobile device.
  // WHY: machine_keys has a foreign key to machines.id. We need a machine
  // record to store the mobile's public key. The machine_fingerprint is
  // set to `mobile_{userId}` to distinguish it from CLI machines.
  const mobileMachineFingerprint = `mobile_${userId}`;

  const { data: existingMachine } = await supabase
    .from('machines')
    .select('id')
    .eq('user_id', userId)
    .eq('machine_fingerprint', mobileMachineFingerprint)
    .maybeSingle();

  let machineId: string;

  if (existingMachine) {
    machineId = existingMachine.id;
  } else {
    // Create a machine record for the mobile device
    const { data: newMachine, error: machineError } = await supabase
      .from('machines')
      .insert({
        user_id: userId,
        name: 'Mobile App',
        machine_fingerprint: mobileMachineFingerprint,
        platform: 'ios', // WHY: We default to ios; could be refined with Platform.OS
        is_online: true,
        is_enabled: true,
      })
      .select('id')
      .single();

    if (machineError || !newMachine) {
      throw new Error(
        `Failed to create mobile machine record: ${machineError?.message ?? 'unknown error'}`
      );
    }

    machineId = newMachine.id;
    logger.log('Created mobile machine record:', machineId);
  }

  // Step 2: Upsert the public key into machine_keys.
  // WHY upsert: The machine_keys table has a UNIQUE constraint on machine_id
  // (one active key per machine). Upsert handles both initial registration
  // and key rotation (re-pairing after keypair regeneration).
  const { error: keyError } = await supabase
    .from('machine_keys')
    .upsert(
      {
        machine_id: machineId,
        public_key: publicKeyBase64,
        fingerprint,
      },
      { onConflict: 'machine_id' }
    );

  if (keyError) {
    throw new Error(`Failed to register public key: ${keyError.message}`);
  }

  logger.log(`Registered public key for mobile device (fingerprint: ${fingerprint})`);
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clears all cached encryption data.
 * Called when the user unpairs or signs out so stale keys
 * are not used with a different pairing.
 *
 * WHY: If the user unpairs and re-pairs with a different CLI machine,
 * the cached recipient keys from the previous pairing would cause
 * encryption to the wrong device. Clearing the cache forces a fresh
 * lookup from machine_keys on next encrypt/decrypt.
 */
export function clearEncryptionCache(): void {
  cachedKeyPair = null;
  recipientKeyCache.clear();
  logger.log('Cleared encryption cache');
}

/**
 * Invalidates the cached public key for a specific machine.
 * Called when key rotation is detected or a decryption error suggests
 * the cached key is stale.
 *
 * @param machineId - The UUID of the machine whose cached key should be invalidated
 */
export function invalidateRecipientKey(machineId: string): void {
  recipientKeyCache.delete(machineId);
  logger.log(`Invalidated cached key for machine ${machineId}`);
}
