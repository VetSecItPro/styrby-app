/**
 * Tier-check utilities (Phase 0.9.2)
 *
 * Single source of truth for cross-surface tier gating. Both styrby-web
 * and styrby-mobile were re-implementing these independently, leading to
 * subtle drift in what each surface allowed. By centralising here we
 * guarantee that a tier-gating decision is always consistent (SOC2 CC6.1).
 *
 * Design constraints:
 * - Zero platform-specific imports. Safe in Node, Deno, browser, Hermes.
 * - No circular dependencies: does NOT import from billing/tier-logic.ts
 *   (which knows only the four original tiers). This module covers all six
 *   billing tiers including the team family introduced in Phase 2.
 * - Pure functions: all inputs explicit, no module-level mutable state.
 *
 * @module tiers/utils
 */

// ============================================================================
// Tier identifier
// ============================================================================

/**
 * All tier identifiers that exist anywhere in the billing system.
 *
 * Ordering within this union is significant: see {@link TIER_ORDER} and
 * {@link compareTiers} for the canonical upgrade path.
 *
 * WHY 'power' not 'pro': the Styrby subscription product uses 'power' as
 * the solo-user paid tier (see CLAUDE.md pricing). 'pro' is a legacy alias
 * kept for DB compat; {@link normalizeTierFull} maps it to 'power'.
 */
export type FullTierId =
  | 'free'
  | 'power'
  | 'team'
  | 'business'
  | 'enterprise';

/**
 * Resources whose limits vary by tier.
 *
 * - `agents`: max simultaneous AI agents a user / team member may connect.
 * - `sessionsPerDay`: max sessions that can be started in a 24-hour window.
 * - `seats`: max team seats (0 for solo tiers; Infinity for enterprise).
 * - `retentionDays`: how many days of session history is retained.
 */
export type TierResource = 'agents' | 'sessionsPerDay' | 'seats' | 'retentionDays';

/**
 * Feature capability keys used by {@link canAccessFeature}.
 *
 * Each key maps to a boolean: is the feature available on the given tier?
 */
export type TierFeatureKey =
  | 'multi_agent'       // More than one simultaneous agent
  | 'unlimited_history' // Session retention beyond 7 days
  | 'byok'              // Bring Your Own Key (custom API keys)
  | 'api_access'        // Programmatic REST/WS API
  | 'budget_alerts'     // Spending threshold notifications
  | 'cost_dashboard'    // Full cost breakdown dashboard
  | 'team_admin'        // Manage team members and policies
  | 'approval_chains'   // Require admin approval before CLI commands
  | 'audit_log'         // Full audit trail export
  | 'sso'               // Enterprise SSO / SAML
  | 'custom_retention'  // Configure retention period
  | 'priority_support'; // Dedicated support channel

// ============================================================================
// Internal definitions (not exported — use the function API)
// ============================================================================

/**
 * Canonical upgrade order. Index 0 = most restrictive (free), last = most
 * permissive (enterprise). Used by {@link compareTiers}.
 */
const TIER_ORDER: FullTierId[] = [
  'free',
  'power',
  'team',
  'business',
  'enterprise',
] as const;

/**
 * Numeric limits per tier per resource.
 *
 * `Infinity` means "no practical limit" (unlimited). 0 means "not applicable"
 * (e.g. solo tiers have 0 seats because the concept does not apply).
 *
 * Source of truth: CLAUDE.md pricing section + Polar product configuration.
 *
 * WHY seats are 0 for solo tiers: the `seats` resource is only meaningful for
 * team billing. Returning 0 lets callers do `if (getLimit(t,'seats') > 0)` to
 * detect team-tier contexts without needing `isTeamTier()`.
 */
const TIER_NUMERIC_LIMITS: Record<FullTierId, Record<TierResource, number>> = {
  free: {
    agents: 3,          // 3 agents per CLAUDE.md ("Free: 3 agents")
    sessionsPerDay: 50, // 50 sessions/month ≈ ~1.67/day; stored as monthly below
    seats: 0,
    retentionDays: 7,
  },
  power: {
    agents: 11,          // All 11 supported agents
    sessionsPerDay: Infinity,
    seats: 0,
    retentionDays: Infinity,
  },
  team: {
    agents: 11,
    sessionsPerDay: Infinity,
    seats: Infinity,     // Per-team seat count managed by billing, no hard cap
    retentionDays: Infinity,
  },
  business: {
    agents: 11,
    sessionsPerDay: Infinity,
    seats: Infinity,
    retentionDays: Infinity,
  },
  enterprise: {
    agents: 11,
    sessionsPerDay: Infinity,
    seats: Infinity,
    retentionDays: Infinity,
  },
};

/**
 * Feature availability matrix per tier.
 *
 * WHY a flat boolean matrix (not inheritance): explicit beats implicit for
 * SOC2 audit purposes. An auditor can read this table and immediately verify
 * that, e.g., `sso` is only on enterprise without tracing inheritance chains.
 */
const TIER_FEATURES: Record<FullTierId, Record<TierFeatureKey, boolean>> = {
  free: {
    multi_agent: false,
    unlimited_history: false,
    byok: false,
    api_access: false,
    budget_alerts: false,
    cost_dashboard: false,
    team_admin: false,
    approval_chains: false,
    audit_log: false,
    sso: false,
    custom_retention: false,
    priority_support: false,
  },
  power: {
    multi_agent: true,
    unlimited_history: true,
    byok: true,
    api_access: true,
    budget_alerts: true,
    cost_dashboard: true,
    team_admin: false,
    approval_chains: false,
    audit_log: false,
    sso: false,
    custom_retention: false,
    priority_support: false,
  },
  team: {
    multi_agent: true,
    unlimited_history: true,
    byok: true,
    api_access: true,
    budget_alerts: true,
    cost_dashboard: true,
    team_admin: true,
    approval_chains: true,
    audit_log: true,
    sso: false,
    custom_retention: false,
    priority_support: false,
  },
  business: {
    multi_agent: true,
    unlimited_history: true,
    byok: true,
    api_access: true,
    budget_alerts: true,
    cost_dashboard: true,
    team_admin: true,
    approval_chains: true,
    audit_log: true,
    sso: false,
    custom_retention: true,
    priority_support: true,
  },
  enterprise: {
    multi_agent: true,
    unlimited_history: true,
    byok: true,
    api_access: true,
    budget_alerts: true,
    cost_dashboard: true,
    team_admin: true,
    approval_chains: true,
    audit_log: true,
    sso: true,
    custom_retention: true,
    priority_support: true,
  },
};

// ============================================================================
// Public utilities
// ============================================================================

/**
 * Resolves an arbitrary string to a known {@link FullTierId}, defaulting to
 * `'free'` for any unknown value.
 *
 * WHY fail-closed to 'free': an unrecognised tier must never accidentally
 * grant paid features. Mapping it to the most-restrictive tier is the safe
 * default (SOC2 CC6.1).
 *
 * @param raw - Raw tier string from DB, JWT claim, or API response.
 * @returns A validated {@link FullTierId}.
 *
 * @example
 * ```ts
 * const tier = normalizeTierFull(user.subscription?.tier);
 * ```
 */
export function normalizeTierFull(raw: string | null | undefined): FullTierId {
  switch (raw) {
    case 'power':
    case 'pro':        // legacy alias
      return 'power';
    case 'team':
      return 'team';
    case 'business':
      return 'business';
    case 'enterprise':
      return 'enterprise';
    default:
      return 'free';
  }
}

/**
 * Returns the numeric limit for a resource on the given tier.
 *
 * Returns `Number.POSITIVE_INFINITY` for unlimited resources and `0` for
 * resources that are not applicable to the tier (e.g. `seats` on 'free').
 *
 * @param tier - The tier identifier.
 * @param resource - The resource whose limit to look up.
 * @returns The numeric limit (0 = N/A, `Infinity` = unlimited).
 *
 * @example
 * ```ts
 * const max = getTierLimit('free', 'agents'); // 3
 * const unlimited = getTierLimit('power', 'sessionsPerDay'); // Infinity
 * ```
 */
export function getTierLimit(tier: FullTierId, resource: TierResource): number {
  // WHY double fallback: normalizeTierFull is called by callers who already
  // hold a FullTierId, but some callers pass raw strings. Defensive lookup
  // ensures we never index undefined.
  const limits = TIER_NUMERIC_LIMITS[tier] ?? TIER_NUMERIC_LIMITS.free;
  return limits[resource];
}

/**
 * Returns `true` when the tier is any paid tier (power, team, business, or
 * enterprise). Returns `false` for 'free'.
 *
 * @param tier - The tier identifier.
 * @returns `true` if paid.
 *
 * @example
 * ```ts
 * if (!isPaidTier(user.tier)) { showUpgradeBanner(); }
 * ```
 */
export function isPaidTier(tier: FullTierId): boolean {
  return tier !== 'free';
}

/**
 * Returns `true` when the tier is one of the team family: 'team',
 * 'business', or 'enterprise'.
 *
 * Use this to guard team-specific UI (member list, policy editor, approval
 * queue) that should never render for solo-user tiers.
 *
 * @param tier - The tier identifier.
 * @returns `true` if the tier is team-family.
 *
 * @example
 * ```ts
 * if (isTeamTier(user.tier)) { renderMemberList(); }
 * ```
 */
export function isTeamTier(tier: FullTierId): boolean {
  return tier === 'team' || tier === 'business' || tier === 'enterprise';
}

/**
 * Returns `true` when the given tier has access to the requested feature.
 *
 * @param tier - The tier identifier.
 * @param feature - The feature key to check.
 * @returns `true` if the feature is available on the tier.
 *
 * @example
 * ```ts
 * if (canAccessFeature('team', 'approval_chains')) {
 *   renderApprovalQueue();
 * }
 * ```
 */
export function canAccessFeature(tier: FullTierId, feature: TierFeatureKey): boolean {
  const features = TIER_FEATURES[tier] ?? TIER_FEATURES.free;
  return features[feature];
}

/**
 * Compares two tier identifiers on the upgrade/downgrade axis.
 *
 * Returns:
 * - `-1` if `a` is a lower tier than `b` (a would need to upgrade to reach b)
 * - `0` if `a` and `b` are the same tier
 * - `1` if `a` is a higher tier than `b` (a is already above b)
 *
 * Useful for computing whether a proposed action is an upgrade, downgrade, or
 * no-op, and for sorting tier options in the pricing UI.
 *
 * @param a - First tier identifier.
 * @param b - Second tier identifier.
 * @returns `-1 | 0 | 1`
 *
 * @example
 * ```ts
 * const direction = compareTiers('team', 'free'); // 1 (team is above free)
 * const isUpgrade = compareTiers(next, current) > 0;
 * ```
 */
export function compareTiers(a: FullTierId, b: FullTierId): -1 | 0 | 1 {
  const ia = TIER_ORDER.indexOf(a);
  const ib = TIER_ORDER.indexOf(b);

  // WHY indexOf fallback: unknown tier ids will return -1. Treating -1 as
  // index 0 (free) is the safest interpretation — an unknown tier is assumed
  // to be the minimum tier for comparison purposes.
  const safeA = ia === -1 ? 0 : ia;
  const safeB = ib === -1 ? 0 : ib;

  if (safeA < safeB) return -1;
  if (safeA > safeB) return 1;
  return 0;
}
