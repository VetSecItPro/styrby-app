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

import { loadPersistedData } from '@/persistence';
import { StyrbyApiClient } from '@/api/styrbyApiClient';

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
