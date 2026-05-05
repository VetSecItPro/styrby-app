/**
 * Helper: load PersistedData → return an authenticated StyrbyApiClient.
 *
 * Single source of truth for "the CLI's apiClient" (H41 Phase 4 onward).
 * Every Category-A callsite that previously did `supabase.from(...)` now
 * imports this and calls `getApiClient()` instead.
 *
 * H41 Phase 5 mints `styrbyApiKey` during onboarding. Phase 4 swaps assume
 * the key is present. If it isn't (existing CLI installs that pre-date
 * Phase 5), callers get a clear actionable error rather than a silent 401.
 *
 * @module api/clientFromPersistence
 */

import { loadPersistedData, savePersistedData } from '@/persistence';
import { StyrbyApiClient } from '@/api/styrbyApiClient';
import { getSecret, migrateLegacySecret } from '@/auth/secret-store';
import { logger } from '@/ui/logger';

/**
 * Keychain entry name for the per-user `styrby_*` API key.
 *
 * SECURITY (CLI-006, audit 2026-05-04): Stored in the OS keychain via
 * `secret-store`, falling back to AES-256-GCM encrypted file when the
 * keychain is unreachable (headless servers, no D-Bus). Never plaintext.
 */
const STYRBY_API_KEY_SECRET = 'styrby_api_key';

/**
 * Async resolver: prefer the keychain, fall back to legacy data.json (and
 * silently migrate the value into the keychain on first read post-upgrade).
 *
 * Synchronous getApiClient() / tryGetApiClient() preserved for callers that
 * still expect sync — they continue to read data.json. Async variants are
 * the new preferred path.
 */
async function resolveApiKey(): Promise<string | null> {
  // Fast path: secret already lives in the keychain.
  const keychainKey = await getSecret(STYRBY_API_KEY_SECRET);
  if (keychainKey) return keychainKey;

  // Slow path: legacy data.json. If found, migrate it into the keychain so
  // the next call hits the fast path.
  const data = loadPersistedData();
  const legacy = data?.styrbyApiKey;
  if (!legacy) return null;

  const result = await migrateLegacySecret(STYRBY_API_KEY_SECRET, legacy);
  if (result === 'migrated') {
    // Best-effort: clear the legacy field from data.json so it isn't double-stored.
    try {
      const updated = { ...data, styrbyApiKey: undefined };
      savePersistedData(updated as typeof data);
      logger.debug('[clientFromPersistence] Migrated styrby_api_key from data.json -> keychain');
    } catch (e) {
      // Non-fatal: the key is now in the keychain; data.json still has it but
      // we tried. The next migration attempt will be a no-op (already-keychain).
      logger.debug('[clientFromPersistence] Could not clear legacy key from data.json', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return legacy;
}

/**
 * Distinct error subclass so callers can `instanceof MissingStyrbyKeyError`
 * to surface a re-onboard prompt rather than a generic auth failure.
 *
 * WHY a class (not just a string code): callers can branch on the error type
 * at the catch site — typically `if (err instanceof MissingStyrbyKeyError)
 * print "run styrby onboard --refresh"`.
 */
export class MissingStyrbyKeyError extends Error {
  constructor(message = 'No styrby_* API key on disk. Run `styrby onboard --refresh` to mint one.') {
    super(message);
    this.name = 'MissingStyrbyKeyError';
  }
}

/**
 * Construct an authenticated StyrbyApiClient from persisted data.
 *
 * @returns A StyrbyApiClient with the per-user `styrby_*` key set.
 * @throws {MissingStyrbyKeyError} If no key is on disk (post-Phase-5 onboard
 *   should have minted one; if not, the CLI was installed pre-Phase-5 and
 *   the user must re-onboard).
 *
 * @example
 * try {
 *   const client = getApiClient();
 *   await client.createTemplate({ name, content });
 * } catch (err) {
 *   if (err instanceof MissingStyrbyKeyError) {
 *     console.log(chalk.yellow(err.message));
 *     process.exit(1);
 *   }
 *   throw err;
 * }
 */
export function getApiClient(): StyrbyApiClient {
  const data = loadPersistedData();
  if (!data?.styrbyApiKey) {
    throw new MissingStyrbyKeyError();
  }
  return new StyrbyApiClient({ apiKey: data.styrbyApiKey });
}

/**
 * Same as getApiClient() but returns null instead of throwing when no key
 * is present. Used by callsites that want to opportunistically use the
 * apiClient when available, falling back to legacy Supabase paths during
 * the H41 transition.
 *
 * WHY this opt-in nullable variant: some flows (cost-reporter, audit logs)
 * fire on every CLI action — failing them with MissingStyrbyKeyError on
 * pre-Phase-5 installs would break the CLI for existing users. Callers
 * that can degrade gracefully use this helper; callers that require the
 * key (templates, contexts) use getApiClient() with the explicit error.
 */
export function tryGetApiClient(): StyrbyApiClient | null {
  const data = loadPersistedData();
  if (!data?.styrbyApiKey) {
    return null;
  }
  return new StyrbyApiClient({ apiKey: data.styrbyApiKey });
}

/**
 * Async variant: read the styrby API key from the OS keychain (CLI-006),
 * falling back to the legacy data.json field. Migrates legacy values into
 * the keychain on first read.
 *
 * @throws {MissingStyrbyKeyError} If no key is found in either location.
 */
export async function getApiClientAsync(): Promise<StyrbyApiClient> {
  const apiKey = await resolveApiKey();
  if (!apiKey) throw new MissingStyrbyKeyError();
  return new StyrbyApiClient({ apiKey });
}

/**
 * Async non-throwing variant of {@link tryGetApiClient}.
 */
export async function tryGetApiClientAsync(): Promise<StyrbyApiClient | null> {
  const apiKey = await resolveApiKey();
  return apiKey ? new StyrbyApiClient({ apiKey }) : null;
}
