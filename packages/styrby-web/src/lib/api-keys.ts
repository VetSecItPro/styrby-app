/**
 * API Key Hashing Utilities
 *
 * Provides bcrypt-based hashing and verification for API keys.
 * Used by the API keys CRUD route and authentication middleware.
 *
 * Security Design:
 * - Keys are hashed with bcrypt (cost factor 12)
 * - Verification uses constant-time comparison (via bcrypt)
 * - Plaintext keys are NEVER logged or stored
 *
 * WHY bcrypt over other algorithms:
 * - Built-in salting prevents rainbow table attacks
 * - Configurable cost factor for future-proofing
 * - Well-audited, battle-tested implementation
 * - Slow by design, making brute-force attacks impractical
 */

import bcrypt from 'bcrypt';

/**
 * The cost factor for bcrypt hashing.
 *
 * WHY 12: Provides a good balance between security and performance.
 * - 10 = ~100ms per hash (default)
 * - 12 = ~300ms per hash (recommended for API keys)
 * - 14 = ~1200ms per hash (may be too slow for user experience)
 *
 * API keys are created infrequently, so we can afford higher cost.
 * Verification happens on every API request, but is still fast (~300ms).
 */
const BCRYPT_COST_FACTOR = 12;

/**
 * Hashes an API key using bcrypt.
 *
 * Called when a new API key is created. The hash is stored in the database,
 * while the plaintext key is shown to the user once and then discarded.
 *
 * @param key - The plaintext API key to hash
 * @returns A promise resolving to the bcrypt hash
 *
 * @example
 * const { key, prefix } = generateApiKey();
 * const hash = await hashApiKey(key);
 *
 * // Store in database:
 * await supabase.from('api_keys').insert({
 *   key_prefix: prefix,
 *   key_hash: hash,
 *   ...
 * });
 *
 * @throws {Error} If hashing fails (rare, indicates system issue)
 */
export async function hashApiKey(key: string): Promise<string> {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid API key: must be a non-empty string');
  }

  try {
    const hash = await bcrypt.hash(key, BCRYPT_COST_FACTOR);
    return hash;
  } catch (error) {
    // Log the error type but not the key itself
    console.error('Failed to hash API key:', error instanceof Error ? error.message : 'Unknown error');
    throw new Error('Failed to hash API key');
  }
}

/**
 * Verifies an API key against a bcrypt hash.
 *
 * Called by the authentication middleware on every API request.
 * Uses bcrypt's built-in constant-time comparison to prevent timing attacks.
 *
 * @param key - The plaintext API key from the request
 * @param hash - The bcrypt hash from the database
 * @returns A promise resolving to true if the key matches, false otherwise
 *
 * @example
 * const isValid = await verifyApiKey(requestKey, storedHash);
 * if (!isValid) {
 *   return Response.json({ error: 'Invalid API key' }, { status: 401 });
 * }
 */
export async function verifyApiKey(key: string, hash: string): Promise<boolean> {
  if (!key || typeof key !== 'string' || !hash || typeof hash !== 'string') {
    return false;
  }

  try {
    const isValid = await bcrypt.compare(key, hash);
    return isValid;
  } catch (error) {
    // Log the error type but not the key or hash
    console.error('Failed to verify API key:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

/**
 * Synchronous version of hashApiKey for use in contexts where async is not available.
 *
 * WHY: Some build contexts or edge cases may need sync hashing.
 * PREFER: Use the async version whenever possible for better performance.
 *
 * @param key - The plaintext API key to hash
 * @returns The bcrypt hash
 */
export function hashApiKeySync(key: string): string {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid API key: must be a non-empty string');
  }

  try {
    const hash = bcrypt.hashSync(key, BCRYPT_COST_FACTOR);
    return hash;
  } catch (error) {
    console.error('Failed to hash API key (sync):', error instanceof Error ? error.message : 'Unknown error');
    throw new Error('Failed to hash API key');
  }
}

/**
 * Synchronous version of verifyApiKey.
 *
 * @param key - The plaintext API key from the request
 * @param hash - The bcrypt hash from the database
 * @returns True if the key matches, false otherwise
 */
export function verifyApiKeySync(key: string, hash: string): boolean {
  if (!key || typeof key !== 'string' || !hash || typeof hash !== 'string') {
    return false;
  }

  try {
    return bcrypt.compareSync(key, hash);
  } catch (error) {
    console.error('Failed to verify API key (sync):', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}
