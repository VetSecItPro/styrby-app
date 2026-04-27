/**
 * Tier Limit Enforcement Utility
 *
 * Server-side enforcement for subscription tier limits. This module provides
 * a single authoritative function for checking whether a user has exceeded
 * their plan's quota for a given resource type.
 *
 * WHY this exists (SEC-LOGIC-002): TIER_LIMITS in @styrby/shared define caps
 * for maxSessionsPerDay and maxAgents, but previously those caps only existed
 * in the UI. A free-tier user could bypass them by calling the API directly.
 * This module enforces the same caps on the server side, regardless of how
 * the request was initiated.
 *
 * WHY the resolver cross-reads `subscriptions.tier` AND `teams.billing_tier`
 * (SEC-ADV-004): A team admin whose team is on `teams.billing_tier='growth'`
 * but who has no personal `subscriptions` row (or an outdated one with
 * `tier='free'`) was previously receiving free-tier limits despite their team
 * paying. We now compute the EFFECTIVE tier as
 *   max(personal_subscription_tier, max(team_billing_tier_for_active_memberships))
 * over the canonical tier ordering free < pro < growth. This:
 *   - avoids a backfill migration (no risk of inconsistent state during deploy)
 *   - avoids tying tier sync to team membership change triggers
 *   - honors admin overrides that elevate a personal tier above the team tier
 *   - correctly handles users on multiple teams (max across team memberships)
 *
 * Design principles:
 * - Fail-closed: if tier lookup fails, defaults to 'free' (most restrictive)
 * - Infinity limits (pro/growth for sessions) skip DB count
 * - Returns structured errors so callers can surface actionable messages
 *
 * ---------------------------------------------------------------------------
 * 2026-04-27 — Tier reconciliation refactor (Phase 5)
 * ---------------------------------------------------------------------------
 *
 * EffectiveTierId collapsed from 6 values to 3: `'free' | 'pro' | 'growth'`.
 * Legacy enum values (`power`, `team`, `business`, `enterprise`) are still
 * possible in `subscriptions.tier` (historical rows) and therefore still
 * possible in `teams.billing_tier`. {@link LEGACY_TIER_ALIASES} resolves
 * those to their post-rename equivalents at read time so that:
 *   - The enforcement layer never sees the legacy strings.
 *   - No DB backfill is required to ship the rename safely.
 *   - The DB enum can keep the legacy values forever (Postgres cannot drop
 *     enum values without a rebuild) without polluting application logic.
 *
 * See `.audit/styrby-fulltest.md` Decision #7 / #8 for the canonical mapping.
 *
 * Compliance: SOC2 CC6.1 (logical access enforcement) + OWASP ASVS V11.
 */

import { TIER_LIMITS } from '@styrby/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Tier identifier + ordering
// ---------------------------------------------------------------------------

/**
 * The canonical set of tier identifiers used by the gating layer post the
 * 2026-04-27 reconciliation. Historical DB rows holding legacy values
 * (`power`, `team`, `business`, `enterprise`) are mapped to one of these
 * via {@link LEGACY_TIER_ALIASES} before they reach any consumer.
 *
 * Order in {@link TIER_ORDER} is the canonical upgrade path used by
 * {@link rankTier} and {@link resolveEffectiveTier}.
 */
export type EffectiveTierId = 'free' | 'pro' | 'growth';

/**
 * Legacy DB enum values that may still appear in `subscriptions.tier` or
 * `teams.billing_tier` from rows written before the 2026-04-27 rename.
 *
 * Includes both the canonical post-rename values (so the alias map is total
 * over every observable string) and the historical aliases.
 */
type ObservableTierString =
  | EffectiveTierId
  | 'power'
  | 'team'
  | 'business'
  | 'enterprise';

/**
 * Maps every observable tier string (canonical or legacy) to a canonical
 * {@link EffectiveTierId}.
 *
 * WHY each legacy mapping (matches `.audit/styrby-fulltest.md` Decision #8):
 *
 * | Legacy value | Maps to | Why |
 * |---|---|---|
 * | `'power'`      | `'growth'`   | Pre-rename `power` granted the "all 11 agents + API" feature set on the cross-read resolver. Mapping it to `growth` preserves the most-permissive tier those users had access to via the rank fold. Bumping single-user `power` to a team-feature tier is intentional: the resolver also takes max() over the team-membership tier, so a true single-user `power` row resolves to `growth` anyway via that path; mapping here keeps the personal-tier read consistent. |
 * | `'team'`       | `'growth'`   | The Team plan was always the multi-seat paid tier; Growth is its post-rename equivalent. |
 * | `'business'`   | `'growth'`   | Business was a superset of Team; collapsed into Growth in the 2-tier model (Decision #1). |
 * | `'enterprise'` | `'growth'`   | Enterprise was a custom-priced superset of Business. Custom deals continue out-of-band; for the gating layer we treat them as Growth. |
 *
 * WHY no mapping for `'pro'`: `pro` is a CANONICAL post-rename value (the
 * $39 individual plan), not a legacy alias. It maps to itself.
 *
 * SOC2 CC6.1 — fail-closed: anything not in this map falls through to
 * `'free'` via {@link normalizeEffectiveTier}.
 */
export const LEGACY_TIER_ALIASES: Readonly<Record<ObservableTierString, EffectiveTierId>> = {
  // Canonical (identity)
  free: 'free',
  pro: 'pro',
  growth: 'growth',
  // Legacy
  power: 'growth',
  team: 'growth',
  business: 'growth',
  enterprise: 'growth',
} as const;

/**
 * Canonical upgrade-path ordering. Index 0 = most restrictive (`free`),
 * last = most permissive (`growth`). Used by {@link rankTier} so that
 * cross-reading `max(personal, team)` always picks the higher tier.
 */
const TIER_ORDER: readonly EffectiveTierId[] = ['free', 'pro', 'growth'] as const;

/**
 * Returns the canonical numeric rank for a tier within {@link TIER_ORDER}.
 * Unknown values rank as `0` (free) — fail-closed.
 *
 * @param tier - The tier identifier.
 * @returns The numeric rank (0 = free, higher = more permissive).
 */
export function rankTier(tier: EffectiveTierId): number {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? 0 : idx;
}

/**
 * Normalises an arbitrary string to a canonical {@link EffectiveTierId},
 * resolving legacy aliases through {@link LEGACY_TIER_ALIASES} and
 * defaulting to `'free'` for any unknown value.
 *
 * WHY fail-closed to 'free' (SOC2 CC6.1): an unrecognised tier must never
 * accidentally grant paid features. Mapping it to the most-restrictive tier
 * is the safe default.
 *
 * @param raw - Raw tier string from DB / API.
 * @returns A validated canonical {@link EffectiveTierId}.
 */
export function normalizeEffectiveTier(raw: string | null | undefined): EffectiveTierId {
  if (raw == null) return 'free';
  const mapped = (LEGACY_TIER_ALIASES as Record<string, EffectiveTierId | undefined>)[raw];
  return mapped ?? 'free';
}

/**
 * Picks the higher-ranked tier of two. Used to fold personal and team tier
 * candidates into a single effective tier.
 *
 * @param a - First tier.
 * @param b - Second tier.
 * @returns Whichever of `a` / `b` ranks higher in {@link TIER_ORDER}.
 */
export function maxTier(a: EffectiveTierId, b: EffectiveTierId): EffectiveTierId {
  return rankTier(a) >= rankTier(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two resource types that are enforced via this utility.
 *
 * - maxSessionsPerDay: Rolling 24-hour window of sessions started by the user
 * - maxAgents: Number of distinct configured agents in the user's agent_configs
 */
export type TierLimitType = 'maxSessionsPerDay' | 'maxAgents';

/**
 * Successful result — the user is within their tier's limit.
 */
export interface TierLimitAllowed {
  allowed: true;
}

/**
 * Blocked result — the user has hit or exceeded their tier's limit.
 */
export interface TierLimitBlocked {
  allowed: false;
  /** The maximum allowed by the user's tier. */
  limit: number;
  /** The current usage count. */
  current: number;
  /** The user's resolved effective tier. */
  tier: EffectiveTierId;
  /** URL to upgrade the plan. */
  upgradeUrl: '/pricing';
}

/** Union of allowed/blocked outcomes from {@link checkTierLimit}. */
export type TierLimitResult = TierLimitAllowed | TierLimitBlocked;

// ---------------------------------------------------------------------------
// Internal helpers — DB reads
// ---------------------------------------------------------------------------

/**
 * Reads the user's personal subscription tier.
 *
 * WHY fail-closed default: if the subscriptions table returns an error or no
 * active row, we treat the personal tier as 'free'. This prevents a DB
 * hiccup from granting unlimited access. The team-tier read below may still
 * elevate the user above 'free' if their team is paying.
 *
 * @param supabase - An authenticated Supabase client.
 * @param userId - The authenticated user's UUID.
 * @returns The user's personal tier — defaulting to 'free' on any miss.
 */
async function readPersonalTier(
  supabase: SupabaseClient,
  userId: string
): Promise<EffectiveTierId> {
  // PERF-DELTA-005: .maybeSingle() not .single(). PostgREST .single() throws
  // PGRST116 when zero rows match (legitimate case for new users with no
  // subscription row yet). The error then leaks into Sentry as noise. With
  // .maybeSingle(), zero rows returns { data: null, error: null } and we
  // cleanly fall through to 'free' tier without an error roundtrip.
  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !data?.tier) {
    return 'free';
  }
  return normalizeEffectiveTier(data.tier as string);
}

/**
 * Reads the maximum `billing_tier` across all active team memberships for
 * the user.
 *
 * WHY join via team_members: each row in team_members represents an ACTIVE
 * membership (rows are deleted on leave; pending invitations live in a
 * separate table). Joining to `teams.billing_tier` gives us the per-team
 * paid tier without needing a denormalised column on the user.
 *
 * WHY fail-closed: any error or empty result yields 'free' — the personal
 * tier is then the sole source of truth for that resolution.
 *
 * @param supabase - An authenticated Supabase client.
 * @param userId - The authenticated user's UUID.
 * @returns The highest-ranking team billing tier across all of the user's
 *   active memberships, or 'free' when the user is on no team.
 */
async function readMaxTeamTier(
  supabase: SupabaseClient,
  userId: string
): Promise<EffectiveTierId> {
  // PostgREST nested-select: pull billing_tier from the related teams row.
  // The CHECK constraint on teams.billing_tier may legitimately hold legacy
  // strings (`team` / `business` / `enterprise`) for rows pre-dating the
  // 2026-04-27 rename — those are normalised through LEGACY_TIER_ALIASES.
  const { data, error } = await supabase
    .from('team_members')
    .select('teams!inner(billing_tier)')
    .eq('user_id', userId);

  if (error || !data || data.length === 0) {
    return 'free';
  }

  let best: EffectiveTierId = 'free';
  for (const row of data) {
    // PostgREST may return `teams` as either an object (one-to-one inferred)
    // or an array (one-to-many) depending on schema introspection. Handle both.
    const teamsRel = (row as { teams?: unknown }).teams;
    const candidates = Array.isArray(teamsRel) ? teamsRel : [teamsRel];
    for (const t of candidates) {
      const raw = (t as { billing_tier?: string } | null | undefined)?.billing_tier;
      best = maxTier(best, normalizeEffectiveTier(raw));
    }
  }
  return best;
}

/**
 * Resolves the EFFECTIVE tier for a user by cross-reading their personal
 * subscription AND every team they belong to, returning the higher-ranking
 * value (SEC-ADV-004).
 *
 * Use this anywhere you previously read `subscriptions.tier` directly for
 * gating purposes. Direct reads are now a footgun because they miss the
 * team-billing path AND skip the legacy-alias normalisation.
 *
 * @param supabase - An authenticated Supabase client.
 * @param userId - The authenticated user's UUID.
 * @returns The user's canonical effective tier id.
 *
 * @example
 * ```ts
 * const tier = await resolveEffectiveTier(supabase, user.id);
 * if (tier === 'free') { return upgradePrompt(); }
 * ```
 */
export async function resolveEffectiveTier(
  supabase: SupabaseClient,
  userId: string
): Promise<EffectiveTierId> {
  // Run both reads in parallel — they are independent and the resolver is
  // hit on every gated request, so latency matters.
  const [personal, team] = await Promise.all([
    readPersonalTier(supabase, userId),
    readMaxTeamTier(supabase, userId),
  ]);
  return maxTier(personal, team);
}

/**
 * Collapses an {@link EffectiveTierId} to the narrower
 * `'free' | 'pro' | 'growth'` set used by the legacy `TIERS` table in
 * `lib/polar.ts` (and re-exported as the `TierId` type there).
 *
 * Post-rename this is an identity function — both the gating-layer
 * EffectiveTierId and the marketing-side TierId converged on the same
 * three values. Kept as an explicit named export so existing callers
 * (`toLegacyTierId(tier)` in API handlers) continue to compile.
 *
 * @param tier - The canonical effective tier.
 * @returns The same tier id (identity post-Phase 5).
 */
export function toLegacyTierId(tier: EffectiveTierId): EffectiveTierId {
  return tier;
}

/**
 * Counts the number of sessions the user has started in the past 24 hours.
 *
 * WHY interval '1 day': Rolling window rather than midnight-reset so a user
 * who starts 5 sessions at 11 PM cannot immediately start 5 more at midnight.
 *
 * @param supabase - An authenticated Supabase client.
 * @param userId - The authenticated user's UUID.
 * @returns Session count over the last 24 hours, or 0 on error.
 */
async function countDailySessions(supabase: SupabaseClient, userId: string): Promise<number> {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('started_at', windowStart);

  if (error) {
    console.error('[tier-enforcement] countDailySessions error:', error.message);
    // Fail-open for counting: return 0 so a DB error doesn't hard-block the user.
    // The tier check itself is still guarded by the limit comparison.
    return 0;
  }

  return count ?? 0;
}

/**
 * Counts the number of distinct configured agents for the user.
 *
 * WHY COUNT(*): Each row in agent_configs represents one configured agent
 * type. The unique constraint on (user_id, agent_type) ensures no
 * double-counting.
 *
 * @param supabase - An authenticated Supabase client.
 * @param userId - The authenticated user's UUID.
 * @returns Number of configured agents, or 0 on error.
 */
async function countAgentConfigs(supabase: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('agent_configs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    console.error('[tier-enforcement] countAgentConfigs error:', error.message);
    return 0;
  }

  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a user has exceeded their EFFECTIVE tier's limit for a
 * given resource. Effective tier is `max(personal_subscription, team_billing)`
 * — see {@link resolveEffectiveTier} (SEC-ADV-004).
 *
 * This is the single authoritative enforcement point for SEC-LOGIC-002. Call
 * it at the start of any API handler that creates a session or agent config
 * before performing any DB writes.
 *
 * Edge cases handled:
 * - `Infinity` limits (pro/growth for sessions) → always allowed, no DB
 *   count query
 * - Tier lookup failure → defaults to 'free' (fail-closed)
 * - Count query failure → returns 0 (fail-open for counting, fail-closed on tier)
 *
 * @param userId - The authenticated user's UUID.
 * @param limitType - Which resource limit to check.
 * @param supabase - An authenticated Supabase client instance.
 * @returns `{ allowed: true }` or `{ allowed: false, limit, current, tier, upgradeUrl }`.
 *
 * @example
 * const result = await checkTierLimit(user.id, 'maxSessionsPerDay', supabase);
 * if (!result.allowed) {
 *   return NextResponse.json(
 *     { error: 'TIER_LIMIT_EXCEEDED', ...result },
 *     { status: 403 }
 *   );
 * }
 */
export async function checkTierLimit(
  userId: string,
  limitType: TierLimitType,
  supabase: SupabaseClient
): Promise<TierLimitResult> {
  // Cross-read personal sub + team memberships → effective tier.
  const tier = await resolveEffectiveTier(supabase, userId);

  // Look up the limit for this tier. TIER_LIMITS in @styrby/shared retains
  // legacy keys as defensive aliases, but resolveEffectiveTier only ever
  // returns canonical values — so this lookup is always one of free/pro/growth.
  const tierLimits = TIER_LIMITS[tier as keyof typeof TIER_LIMITS];
  const limit = tierLimits[limitType] as number;

  // WHY early return: Infinity means unlimited. Skip the DB count entirely
  // to save a round-trip on every gated request.
  if (!isFinite(limit)) {
    return { allowed: true };
  }

  // Count current usage depending on which limit we're checking.
  const current =
    limitType === 'maxSessionsPerDay'
      ? await countDailySessions(supabase, userId)
      : await countAgentConfigs(supabase, userId);

  if (current >= limit) {
    return {
      allowed: false,
      limit,
      current,
      tier,
      upgradeUrl: '/pricing',
    };
  }

  return { allowed: true };
}
