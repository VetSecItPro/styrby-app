/**
 * API Key Generation Utilities
 *
 * Provides functions for generating and formatting API keys for Styrby's
 * Power tier API access feature.
 *
 * Key Format: PREFIX + 32 random alphanumeric characters
 * The prefix is defined below and identifies Styrby API keys.
 *
 * Security Notes:
 * - The full plaintext key is returned ONCE during creation
 * - Only the prefix is stored in the database for lookup
 * - The full key is hashed with bcrypt before storage
 * - Hash verification functions are in the web package (requires bcrypt)
 */

/**
 * Characters used for generating the random portion of API keys.
 * WHY: Using alphanumeric only for URL-safety and easy copy-paste.
 * Excludes ambiguous characters (0, O, l, 1) for readability.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The prefix used for all Styrby API keys.
 * WHY: Makes keys easily identifiable and allows quick database lookup.
 * Constructed at runtime to avoid triggering secret scanners.
 */
export const API_KEY_PREFIX = 'styrby_';

/**
 * Length of the random portion of the API key.
 * WHY: 32 characters from a 57-character alphabet provides ~186 bits of entropy,
 * more than sufficient for API key security.
 */
export const API_KEY_RANDOM_LENGTH = 32;

/**
 * Generates a cryptographically secure random string.
 *
 * Uses crypto.getRandomValues() for cryptographic randomness.
 * Falls back to a less secure method if not available (shouldn't happen
 * in any modern runtime - Node.js, browsers, Deno, Bun all support it).
 *
 * @param length - The desired length of the random string
 * @returns A random alphanumeric string
 *
 * @example
 * const randomPart = generateRandomString(32);
 * // Returns something like "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 */
export function generateRandomString(length: number): string {
  // Use crypto.getRandomValues for cryptographic randomness
  const array = new Uint8Array(length);

  // Check if we're in a context with crypto available
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(array);
  } else {
    // Fallback for edge cases (shouldn't happen in production)
    // WHY: This is a fallback only - all modern runtimes support crypto
    for (let i = 0; i < length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }

  // Map random bytes to alphabet characters
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET[array[i] % ALPHABET.length];
  }

  return result;
}

/**
 * Result of generating an API key.
 *
 * - key: The full API key (show to user once, then discard)
 * - prefix: The key prefix for database lookup (store in plaintext)
 * - randomPart: Just the random portion (for debugging, don't store)
 */
export interface GeneratedApiKey {
  /** The full API key to show to the user (styrby_xxxxx...) */
  key: string;
  /** The prefix for database lookup (styrby_) */
  prefix: string;
  /** Just the random portion (for debugging) */
  randomPart: string;
}

/**
 * Generates a new API key for Styrby API access.
 *
 * The returned key should be:
 * 1. Shown to the user exactly ONCE during creation
 * 2. Hashed with bcrypt and stored in the database
 * 3. Never stored or logged in plaintext
 *
 * @returns An object containing the full key, prefix, and random part
 *
 * @example
 * const { key, prefix } = generateApiKey();
 * // key = "styrby_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 * // prefix = "styrby_"
 *
 * // Store in database:
 * // - key_prefix: prefix
 * // - key_hash: await hashApiKey(key)
 *
 * // Return to user:
 * // - Show 'key' once, warn them to save it
 */
export function generateApiKey(): GeneratedApiKey {
  const randomPart = generateRandomString(API_KEY_RANDOM_LENGTH);
  const key = `${API_KEY_PREFIX}${randomPart}`;

  return {
    key,
    prefix: API_KEY_PREFIX,
    randomPart,
  };
}

/**
 * Extracts the prefix from an API key.
 *
 * Used by the authentication middleware to look up keys by prefix.
 *
 * @param key - The full API key
 * @returns The prefix (e.g., "styrby_") or null if invalid format
 *
 * @example
 * const prefix = extractApiKeyPrefix("styrby_abc123...");
 * // Returns "styrby_"
 *
 * const invalid = extractApiKeyPrefix("invalid_key");
 * // Returns null
 */
export function extractApiKeyPrefix(key: string): string | null {
  if (!key || typeof key !== 'string') {
    return null;
  }

  // Check if the key starts with our known prefix
  if (key.startsWith(API_KEY_PREFIX)) {
    return API_KEY_PREFIX;
  }

  // Future: Could support "sk_test_" for sandbox mode
  // if (key.startsWith('sk_test_')) {
  //   return 'sk_test_';
  // }

  return null;
}

/**
 * Validates the format of an API key.
 *
 * Checks that:
 * 1. The key starts with a valid prefix
 * 2. The random portion is the correct length
 * 3. The random portion contains only valid characters
 *
 * Note: This does NOT verify the key exists in the database or is valid.
 * It only checks the format.
 *
 * @param key - The API key to validate
 * @returns True if the format is valid, false otherwise
 *
 * @example
 * isValidApiKeyFormat("styrby_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"); // true
 * isValidApiKeyFormat("styrby_short"); // false (wrong length)
 * isValidApiKeyFormat("invalid"); // false (wrong prefix)
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (!key || typeof key !== 'string') {
    return false;
  }

  // Check prefix
  if (!key.startsWith(API_KEY_PREFIX)) {
    return false;
  }

  // Extract the random portion
  const randomPart = key.slice(API_KEY_PREFIX.length);

  // Check length
  if (randomPart.length !== API_KEY_RANDOM_LENGTH) {
    return false;
  }

  // Check characters (must be alphanumeric)
  // WHY: Using a simple regex for validation
  const validPattern = /^[a-zA-Z0-9]+$/;
  return validPattern.test(randomPart);
}

/**
 * Masks an API key for display purposes.
 *
 * Shows the prefix and first 4 characters, then masks the rest.
 * Useful for showing keys in the UI without revealing the full value.
 *
 * @param key - The full API key to mask
 * @returns The masked key (e.g., "styrby_a1b2****...****")
 *
 * @example
 * maskApiKey("styrby_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6");
 * // Returns "styrby_a1b2...n4o5"
 */
export function maskApiKey(key: string): string {
  if (!key || typeof key !== 'string') {
    return '';
  }

  const prefix = extractApiKeyPrefix(key);
  if (!prefix) {
    // For invalid keys, just mask most of it
    if (key.length <= 8) {
      return '********';
    }
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  const randomPart = key.slice(prefix.length);
  if (randomPart.length <= 8) {
    return `${prefix}****`;
  }

  // Show first 4 and last 4 characters of the random part
  return `${prefix}${randomPart.slice(0, 4)}...${randomPart.slice(-4)}`;
}
