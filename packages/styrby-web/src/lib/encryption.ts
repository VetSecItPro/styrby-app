/**
 * Web Encryption Service
 *
 * Manages E2E NaCl box keypairs for the web dashboard and provides
 * decryption of session messages. Mirrors the mobile encryption service
 * but uses localStorage instead of SecureStore for key persistence.
 *
 * Architecture:
 * - On first use, generates a NaCl box keypair and stores it in localStorage
 * - The public key is registered in `machine_keys` so CLIs can encrypt for the web
 * - For messages encrypted for this web device, decryption succeeds transparently
 * - For messages encrypted for other devices (e.g., mobile), decryption fails
 *   gracefully and a "[Encrypted]" fallback is shown
 *
 * WHY localStorage: The Web Crypto API with non-exportable keys would be more
 * secure, but NaCl (TweetNaCl) operates on raw Uint8Arrays, not CryptoKey objects.
 * localStorage is acceptable here because:
 * 1. The keys protect session message content, not financial credentials
 * 2. An attacker with localStorage access already has the auth session cookie
 * 3. This matches the threat model — E2E encryption protects data in transit
 *    and at rest on the server, not against local device compromise
 */

import {
  generateKeyPair,
  decryptFromStorage,
  encodeBase64,
  decodeBase64,
  generateFingerprint,
  type NaClKeyPair,
} from '@styrby/shared';
import { createClient } from '@/lib/supabase/client';

// ============================================================================
// Constants
// ============================================================================

/**
 * localStorage key for the web device's NaCl box keypair.
 * Stores a JSON object with base64-encoded publicKey and secretKey.
 */
const KEYPAIR_STORAGE_KEY = 'styrby_web_encryption_keypair';

/**
 * localStorage key for the web device's machine ID in machine_keys.
 */
const WEB_MACHINE_ID_KEY = 'styrby_web_machine_id';

// ============================================================================
// Types
// ============================================================================

/**
 * JSON-serializable form of the keypair for localStorage persistence.
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

/** Cached web keypair (loaded from localStorage on first access) */
let cachedKeyPair: NaClKeyPair | null = null;

/**
 * Cached sender public keys indexed by machine ID.
 * WHY: Avoids repeated Supabase queries for the same CLI's public key
 * across all messages in a session.
 */
const senderKeyCache = new Map<string, Uint8Array>();

// ============================================================================
// Key Management
// ============================================================================

/**
 * Gets or creates the web device's NaCl box keypair.
 *
 * On first call, generates a new keypair and stores it in localStorage.
 * Subsequent calls return the cached keypair without re-reading localStorage.
 *
 * @returns The web device's NaCl keypair
 */
export function getOrCreateWebKeyPair(): NaClKeyPair {
  if (cachedKeyPair) return cachedKeyPair;

  // Try to load existing keypair from localStorage
  const stored = localStorage.getItem(KEYPAIR_STORAGE_KEY);
  if (stored) {
    try {
      const parsed: StoredKeyPair = JSON.parse(stored);
      cachedKeyPair = {
        publicKey: decodeBase64(parsed.publicKey),
        secretKey: decodeBase64(parsed.secretKey),
      };
      return cachedKeyPair;
    } catch {
      // Corrupted keypair — regenerate
      localStorage.removeItem(KEYPAIR_STORAGE_KEY);
    }
  }

  // Generate new keypair
  cachedKeyPair = generateKeyPair();

  // Persist to localStorage
  const toStore: StoredKeyPair = {
    publicKey: encodeBase64(cachedKeyPair.publicKey),
    secretKey: encodeBase64(cachedKeyPair.secretKey),
  };
  localStorage.setItem(KEYPAIR_STORAGE_KEY, JSON.stringify(toStore));

  return cachedKeyPair;
}

/**
 * Registers the web device in the machines and machine_keys tables.
 *
 * WHY: Without registration, CLIs don't know the web's public key and
 * cannot encrypt messages for it. This is called once on first session view.
 *
 * Creates a `machines` row (required FK for `machine_keys`) then inserts
 * the web's NaCl public key into `machine_keys`.
 *
 * @returns The web device's machine UUID, or null on failure
 */
export async function registerWebDevice(): Promise<string | null> {
  // Check if already registered
  const existingId = localStorage.getItem(WEB_MACHINE_ID_KEY);
  if (existingId) return existingId;

  const keypair = getOrCreateWebKeyPair();
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const fingerprint = await generateFingerprint(keypair.publicKey);
  const webFingerprint = `web_${fingerprint}`;

  // Step 1: Create a machines row (required FK for machine_keys)
  // WHY: machine_keys.machine_id references machines(id).
  // Platform is null since 'web' is not in the CHECK constraint.
  const { data: machine, error: machineError } = await supabase
    .from('machines')
    .upsert(
      {
        user_id: user.id,
        name: 'Web Dashboard',
        machine_fingerprint: webFingerprint,
        hostname: typeof window !== 'undefined' ? window.location.hostname : 'web',
        is_online: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,machine_fingerprint' }
    )
    .select('id')
    .single();

  if (machineError || !machine) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Encryption] Failed to register web machine:', machineError?.message);
    }
    return null;
  }

  // Step 2: Insert the public key into machine_keys
  const { error: keyError } = await supabase
    .from('machine_keys')
    .upsert(
      {
        machine_id: machine.id,
        public_key: encodeBase64(keypair.publicKey),
        fingerprint,
      },
      { onConflict: 'machine_id' }
    );

  if (keyError) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Encryption] Failed to register web key:', keyError.message);
    }
    return null;
  }

  localStorage.setItem(WEB_MACHINE_ID_KEY, machine.id);
  return machine.id;
}

// ============================================================================
// Key Lookup
// ============================================================================

/**
 * Fetches a CLI machine's public key from machine_keys.
 * Results are cached in memory for the session lifetime.
 *
 * @param machineId - The CLI machine's ID
 * @returns The CLI's public key as Uint8Array, or null if not found
 */
async function getSenderPublicKey(machineId: string): Promise<Uint8Array | null> {
  const cached = senderKeyCache.get(machineId);
  if (cached) return cached;

  const supabase = createClient();
  const { data } = await supabase
    .from('machine_keys')
    .select('public_key')
    .eq('machine_id', machineId)
    .single();

  if (!data?.public_key) return null;

  const publicKey = decodeBase64(data.public_key);
  senderKeyCache.set(machineId, publicKey);
  return publicKey;
}

// ============================================================================
// Decryption
// ============================================================================

/**
 * Result of attempting to decrypt a message.
 */
export interface DecryptResult {
  /** The decrypted plaintext, or null if decryption failed */
  content: string | null;
  /** Whether the content was encrypted (had a nonce) */
  wasEncrypted: boolean;
}

/**
 * Attempts to decrypt a session message.
 *
 * Three possible outcomes:
 * 1. Message is unencrypted (no nonce) → returns content_encrypted as plaintext
 * 2. Message is encrypted and we can decrypt → returns decrypted plaintext
 * 3. Message is encrypted but not for us → returns null with wasEncrypted=true
 *
 * @param contentEncrypted - The content_encrypted field from session_messages
 * @param encryptionNonce - The encryption_nonce field (null for plaintext messages)
 * @param machineId - The CLI machine_id that sent this message (from the session)
 * @returns DecryptResult indicating outcome
 */
export async function tryDecryptMessage(
  contentEncrypted: string | null,
  encryptionNonce: string | null,
  machineId: string | null
): Promise<DecryptResult> {
  // No content at all
  if (!contentEncrypted) {
    return { content: null, wasEncrypted: false };
  }

  // No nonce means the message is stored as plaintext
  // WHY: Messages are only encrypted when E2E is active between paired devices.
  // Many messages (especially early in the product lifecycle) are unencrypted.
  if (!encryptionNonce) {
    return { content: contentEncrypted, wasEncrypted: false };
  }

  // Message is encrypted — attempt decryption
  if (!machineId) {
    return { content: null, wasEncrypted: true };
  }

  try {
    const keypair = getOrCreateWebKeyPair();
    const senderPublicKey = await getSenderPublicKey(machineId);

    if (!senderPublicKey) {
      return { content: null, wasEncrypted: true };
    }

    const plaintext = decryptFromStorage(
      contentEncrypted,
      encryptionNonce,
      senderPublicKey,
      keypair.secretKey
    );

    return { content: plaintext, wasEncrypted: true };
  } catch {
    // Decryption failed — message was encrypted for a different device
    // WHY: This is expected behavior when messages were encrypted for the
    // mobile device, not the web. NaCl box.open returns null for wrong keys.
    return { content: null, wasEncrypted: true };
  }
}
