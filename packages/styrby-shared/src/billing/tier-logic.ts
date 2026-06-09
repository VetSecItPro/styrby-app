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
 * The subscription tier identifiers. See the canonical tier model in
 * `docs/planning/styrby-tiers-canonical.md`.
 *
 * ACTIVE (sold today): `'free'`, `'pro'`, `'growth'`.
 * `'team'` is a never-shipped placeholder retained only because `TIER_LIMITS`
 *   and the DB enum still carry it; do not surface it.
 *
 * NOTE: `'power'` was RETIRED (migration 095, 2026-06-09) — zero customers; the
 * lone comp account was migrated to `'growth'`. It is deliberately absent from
 * this union. The only place that still acknowledges it is {@link normalizeTier},
 * which maps a stray raw `'power'` string to `'growth'` as a one-way legacy
 * bridge. Never add `'power'` to new code.
 */
export type TierId = 'free' | 'pro' | 'growth' | 'team';

/**
 * Returns true when the tier grants PREMIUM (top-tier) features — Cloud Tasks,
 * Notifications smart-filter, Metrics OTEL export, etc.
 *
 * Premium = `'growth'` (the single premium tier). `'pro'` is a paid INDIVIDUAL
 * tier and is NOT premium; `'free'` is not premium. This is the single
 * entitlement gate every premium feature should call — never compare against a
 * bare tier string.
 *
 * @param tier - The user's resolved subscription tier.
 * @returns `true` when the tier is `'growth'`.
 *
 * @example
 * ```ts
 * if (!isPremiumTier(tier)) return <UpgradePrompt feature="Cloud Tasks" />;
 * ```
 */
export function isPremiumTier(tier: TierId | string | null | undefined): boolean {
  return tier === 'growth';
}

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
 * This is the ONE legacy bridge for the retired `'power'` tier (migration 095):
 * a stray raw `'power'` string (e.g. from a never-migrated historical row or an
 * audit-log entry) maps to `'growth'` — the tier it became. No other code path
 * acknowledges `'power'`.
 *
 * @param raw - The raw tier string from the database / API response.
 * @returns A safe {@link TierId} value.
 */
export function normalizeTier(raw: string | null | undefined): TierId {
  switch (raw) {
    case 'pro':
    case 'growth':
    case 'team':
      return raw;
    case 'power':
      // Legacy bridge: 'power' was retired (migration 095) and folds into the
      // tier that replaced it. Zero rows in production, but defensive.
      return 'growth';
    default:
      // WHY fail-closed to 'free': unknown / legacy-unused values
      // ('business', 'enterprise') and typos must never grant a paid tier.
      return 'free';
  }
}
