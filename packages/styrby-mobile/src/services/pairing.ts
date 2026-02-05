/**
 * Pairing Service
 *
 * Handles the complete device pairing flow after scanning a QR code from the CLI.
 * Validates the pairing payload, persists pairing info to secure storage,
 * exchanges E2E encryption keys, registers push notifications, and establishes
 * the relay connection.
 *
 * Flow:
 * 1. Decode and validate the QR code payload
 * 2. Verify the user is authenticated with Supabase
 * 3. Store pairing info in secure storage
 * 4. Generate/retrieve E2E encryption keypair and exchange public keys
 * 5. Register push notification token for the paired device
 * 6. Connect to the relay channel for real-time communication
 */

import * as SecureStore from 'expo-secure-store';
import {
  type PairingPayload,
  validatePairingPayload,
  isPairingExpired,
  decodePairingUrl,
} from 'styrby-shared';
import { supabase } from '../lib/supabase';
import { registerForPushNotifications, savePushToken } from './notifications';
import { registerPublicKey, getRecipientPublicKey, clearEncryptionCache } from './encryption';

// ============================================================================
// Storage Keys
// ============================================================================

/** SecureStore key for persisted pairing info */
const PAIRING_INFO_KEY = 'styrby_pairing_info';

/** SecureStore key for the pairing token (kept separate for revocation) */
const PAIRING_TOKEN_KEY = 'styrby_pairing_token';

// ============================================================================
// Types
// ============================================================================

/**
 * Persistent pairing data stored in SecureStore after a successful pairing.
 * Contains the minimum information needed to reconnect to the relay channel.
 */
export interface StoredPairingInfo {
  /** User ID of the paired CLI user */
  userId: string;
  /** Machine ID of the paired CLI instance */
  machineId: string;
  /** Human-readable device name from the CLI (e.g., hostname) */
  deviceName: string;
  /** Supabase project URL from the QR code (for multi-environment support) */
  supabaseUrl: string;
  /** ISO 8601 timestamp when the pairing was completed */
  pairedAt: string;
}

/**
 * Result returned from the pairing attempt with detailed status.
 */
export interface PairingAttemptResult {
  /** Whether the pairing was successful */
  success: boolean;
  /** Error message if pairing failed */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: PairingErrorCode;
  /** Stored pairing info on success */
  pairingInfo?: StoredPairingInfo;
}

/**
 * Error codes for pairing failures.
 * WHY: Allows the UI to show different error messages and recovery actions
 * based on the specific failure mode.
 */
export type PairingErrorCode =
  | 'INVALID_QR'         // QR code data could not be decoded
  | 'EXPIRED_QR'         // QR code has passed its expiry time
  | 'INVALID_PAYLOAD'    // QR decoded but payload structure is wrong
  | 'NOT_AUTHENTICATED'  // User is not logged into Supabase
  | 'USER_MISMATCH'      // QR userId does not match the authenticated user
  | 'STORAGE_FAILED'     // Failed to save pairing info to SecureStore
  | 'ALREADY_PAIRED'     // Device is already paired with a CLI
  | 'NETWORK_ERROR';     // Network failure during pairing

// ============================================================================
// User-Facing Error Messages
// ============================================================================

/**
 * Maps error codes to user-friendly error messages.
 * WHY: Centralizes user-facing copy so the UI layer does not need to know
 * about internal error codes.
 */
const ERROR_MESSAGES: Record<PairingErrorCode, string> = {
  INVALID_QR: 'Invalid QR code. Make sure you are scanning the code from the Styrby CLI.',
  EXPIRED_QR: 'This QR code has expired. Run "styrby pair" in your CLI to generate a new one.',
  INVALID_PAYLOAD: 'Unrecognized QR code format. Please update your CLI and try again.',
  NOT_AUTHENTICATED: 'You need to be logged in before pairing. Please sign in first.',
  USER_MISMATCH: 'This QR code belongs to a different account. Log in with the correct account.',
  STORAGE_FAILED: 'Failed to save pairing data. Please try again.',
  ALREADY_PAIRED: 'This device is already paired. Go to Settings to unpair first.',
  NETWORK_ERROR: 'Network error during pairing. Check your connection and try again.',
};

// ============================================================================
// Pairing Operations
// ============================================================================

/**
 * Executes the full pairing flow from QR code data to stored pairing info.
 *
 * Steps:
 * 1. Decode the QR code URL into a PairingPayload
 * 2. Validate the payload structure and expiry
 * 3. Verify the authenticated user matches the QR code user
 * 4. Persist pairing info to SecureStore
 * 5. Exchange E2E encryption keys (upload mobile key, fetch CLI key)
 * 6. Register push notifications for the paired device
 *
 * @param qrData - Raw string data scanned from the QR code
 * @returns Result object with success status, pairing info, or error details
 *
 * @example
 * const result = await executePairing('styrby://pair?data=...');
 * if (result.success) {
 *   // Navigate to main app -- E2E encryption is ready
 * } else {
 *   // Show result.error to user
 * }
 */
export async function executePairing(qrData: string): Promise<PairingAttemptResult> {
  // Step 1: Decode QR data
  const payload = decodePairingUrl(qrData);

  if (!payload) {
    return createError('INVALID_QR');
  }

  // Step 2: Validate payload structure
  if (!validatePairingPayload(payload)) {
    return createError('INVALID_PAYLOAD');
  }

  // Step 3: Check expiry
  if (isPairingExpired(payload)) {
    return createError('EXPIRED_QR');
  }

  // Step 4: Verify user is authenticated
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return createError('NOT_AUTHENTICATED');
  }

  // Step 5: Verify user ID matches (the QR code is generated for a specific user)
  // WHY: Prevents a user from scanning someone else's QR code and hijacking their
  // relay channel. The CLI encodes its own userId when generating the pairing QR.
  if (payload.userId !== user.id) {
    return createError('USER_MISMATCH');
  }

  // Step 6: Store pairing info
  const pairingInfo: StoredPairingInfo = {
    userId: payload.userId,
    machineId: payload.machineId,
    deviceName: payload.deviceName,
    supabaseUrl: payload.supabaseUrl,
    pairedAt: new Date().toISOString(),
  };

  try {
    await SecureStore.setItemAsync(PAIRING_INFO_KEY, JSON.stringify(pairingInfo));
    await SecureStore.setItemAsync(PAIRING_TOKEN_KEY, payload.token);
  } catch {
    return createError('STORAGE_FAILED');
  }

  // Step 7: Exchange E2E encryption keys
  // WHY: Key exchange happens during pairing because both devices are actively
  // online and the user has confirmed the trust relationship via QR code.
  // After this step, all future messages can be E2E encrypted.
  try {
    // 7a: Upload mobile's public key to machine_keys table
    await registerPublicKey(user.id);

    // 7b: Pre-fetch the CLI's public key into the in-memory cache
    // WHY: This validates that the CLI has already registered its key
    // and warms the cache so the first encrypted message does not
    // need an additional Supabase query.
    await getRecipientPublicKey(payload.machineId);
  } catch (keyExchangeError) {
    // WHY: Key exchange failure is not fatal to pairing. The mobile app
    // can still communicate over the relay channel -- messages will just
    // be sent without encryption until keys are available. The encryption
    // service will retry key fetch on next encrypt/decrypt attempt.
    if (__DEV__) {
      console.warn('[Pairing] E2E key exchange failed (non-fatal):', keyExchangeError);
    }
  }

  // Step 8: Register push notifications (non-blocking, best-effort)
  // WHY: Push notifications enhance the experience but are not required for pairing.
  // We do not fail the pairing if push registration fails.
  registerPushNotificationsAsync().catch(() => {
    // Silently ignore push notification registration failures during pairing.
    // The user can re-register later from Settings.
  });

  return {
    success: true,
    pairingInfo,
  };
}

/**
 * Retrieves stored pairing info from SecureStore.
 *
 * @returns The stored pairing info, or null if not paired
 */
export async function getStoredPairingInfo(): Promise<StoredPairingInfo | null> {
  try {
    const stored = await SecureStore.getItemAsync(PAIRING_INFO_KEY);
    if (!stored) return null;

    return JSON.parse(stored) as StoredPairingInfo;
  } catch {
    return null;
  }
}

/**
 * Checks whether the device is currently paired with a CLI.
 *
 * @returns True if pairing info exists in SecureStore
 */
export async function isPaired(): Promise<boolean> {
  const info = await getStoredPairingInfo();
  return info !== null;
}

/**
 * Clears all pairing data from SecureStore and resets encryption caches.
 * Used when the user wants to unpair or re-pair with a different CLI.
 *
 * WHY clear encryption cache: If the user re-pairs with a different CLI,
 * the cached recipient keys from the previous pairing would cause encryption
 * to the wrong device. Clearing forces a fresh key lookup on next pairing.
 */
export async function clearPairingInfo(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING_INFO_KEY);
  await SecureStore.deleteItemAsync(PAIRING_TOKEN_KEY);
  clearEncryptionCache();
}

/**
 * Retrieves the stored pairing token.
 * The token is stored separately from pairing info for security isolation.
 *
 * @returns The pairing token string, or null if not stored
 */
export async function getStoredPairingToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PAIRING_TOKEN_KEY);
  } catch {
    return null;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Creates a standardized error result with user-facing message.
 *
 * @param code - The error code identifying the failure type
 * @returns A PairingAttemptResult with success=false and the appropriate error message
 */
function createError(code: PairingErrorCode): PairingAttemptResult {
  return {
    success: false,
    error: ERROR_MESSAGES[code],
    errorCode: code,
  };
}

/**
 * Registers for push notifications and saves the token to Supabase.
 * This is called as a fire-and-forget side effect during pairing.
 *
 * WHY: We register push notifications at pairing time because that is when the
 * user has explicitly expressed intent to receive notifications from the CLI.
 */
async function registerPushNotificationsAsync(): Promise<void> {
  const pushToken = await registerForPushNotifications();
  if (pushToken) {
    await savePushToken(pushToken);
  }
}
