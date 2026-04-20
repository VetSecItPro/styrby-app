/**
 * Tier-logic utilities (Phase 0.10).
 *
 * Single source of truth for "does this tier have feature X?" and "what is
 * the limit for feature Y on this tier?". Web and mobile both consume this
 * module so a tier-gating decision can never disagree across surfaces — a
 * key audit property (SOC2 CC6.1: logical access enforcement is consistent
 * across the system).
 *
 * The limits themselves still live in `constants.ts` (`TIER_LIMITS`) and
 * the marketing-facing tier metadata still lives in the web package's
 * `polar.ts`. This file is a thin, pure, dependency-free wrapper so it can
 * be tree-shaken into mobile, web, and the CLI without dragging Polar SDK
 * or Next.js into the bundle.
 *
 * @module billing/tier-logic
 */

import { TIER_LIMITS } from '../constants.js';

/**
 * The four tier identifiers that exist anywhere in the system.
 *
 * `'team'` is reserved for the Teams plan that is not yet GA; helpers below
 * recognise it but mobile/web should not surface it until billing ships it.
 */
export type TierId = 'free' | 'pro' | 'power' | 'team';

/**
 * The set of features that are gated by tier. Each entry maps to a property
 * in `TIER_LIMITS[tier]` (either a numeric limit or a boolean capability).
 *
 * WHY a string union (not a record): keeps the public API self-documenting
 * and makes the TypeScript autocomplete deterministic at call sites.
 */
export type TierFeature =
  | 'maxAgents'
  | 'maxSessionsPerDay'
  | 'costDashboard'
  | 'budgetAlerts'
  | 'apiAccess'
  | 'teamFeatures';

/**
 * Returns true when the given tier has the requested feature enabled.
 *
 * For boolean features (`budgetAlerts`, `apiAccess`, `teamFeatures`), this
 * returns the underlying boolean. For string-valued features
 * (`costDashboard`), it returns true when the value is anything other than
 * the most-restrictive `'basic'`. For numeric limits (`maxAgents`,
 * `maxSessionsPerDay`), it returns true when the limit is greater than zero.
 *
 * @param tier - The tier identifier (defaults to most restrictive on unknown).
 * @param feature - The feature key.
 * @returns `true` when the tier grants the feature, otherwise `false`.
 *
 * @example
 * ```ts
 * if (isTierFeatureEnabled(user.tier, 'budgetAlerts')) {
 *   // show budget alert UI
 * }
 * ```
 */
export function isTierFeatureEnabled(tier: TierId, feature: TierFeature): boolean {
  // WHY (SOC2 CC6.1 fail-closed): unknown tier defaults to 'free' so a typo
  // or a future tier id never accidentally unlocks a paid feature.
  const limits = (TIER_LIMITS as Record<string, Record<string, unknown>>)[tier]
    ?? (TIER_LIMITS as Record<string, Record<string, unknown>>).free;
  const value = limits[feature];

  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'basic';
  if (typeof value === 'number') return value > 0;
  // Property absent from the tier object → feature not enabled.
  return false;
}

/**
 * Returns the numeric limit for a quota-style feature on the given tier.
 *
 * For features that are not numeric (booleans, strings) returns `0`. For
 * numeric features that are unlimited (`Infinity` in TIER_LIMITS), returns
 * `Number.POSITIVE_INFINITY` so callers can compare with `>=` cleanly.
 *
 * @param tier - The tier identifier.
 * @param feature - The feature key (only `maxAgents` / `maxSessionsPerDay`
 *   currently have numeric values).
 * @returns The numeric limit, or `0` if the feature is non-numeric.
 *
 * @example
 * ```ts
 * const max = getFeatureLimitFor(user.tier, 'maxAgents'); // 3 for pro
 * if (currentAgents >= max) { showUpgradeModal(); }
 * ```
 */
export function getFeatureLimitFor(tier: TierId, feature: TierFeature): number {
  const limits = (TIER_LIMITS as Record<string, Record<string, unknown>>)[tier]
    ?? (TIER_LIMITS as Record<string, Record<string, unknown>>).free;
  const value = limits[feature];
  if (typeof value === 'number') return value;
  return 0;
}

/**
 * Resolves an arbitrary string to a known {@link TierId}, defaulting to
 * `'free'` for any unknown value. Used to sanitise database reads where
 * the column is a free-form `text` field.
 *
 * @param raw - The raw tier string from the database / API response.
 * @returns A safe {@link TierId} value.
 */
export function normalizeTier(raw: string | null | undefined): TierId {
  switch (raw) {
    case 'pro':
    case 'power':
    case 'team':
      return raw;
    default:
      return 'free';
  }
}
