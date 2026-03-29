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
 * Design principles:
 * - Fail-closed: if tier lookup fails, defaults to 'free' (most restrictive)
 * - Infinity limits (pro/power) always pass without a DB count query
 * - Returns structured errors so callers can surface actionable messages
 */

import { TIER_LIMITS } from '@styrby/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TierId } from '@/lib/polar';

// ---------------------------------------------------------------------------
// Types
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
  /** The user's resolved tier. */
  tier: TierId;
  /** URL to upgrade the plan. */
  upgradeUrl: '/pricing';
}

/** Union of allowed/blocked outcomes from {@link checkTierLimit}. */
export type TierLimitResult = TierLimitAllowed | TierLimitBlocked;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the authenticated user's subscription tier from Supabase.
 *
 * WHY fail-closed default: if the subscriptions table returns an error or no
 * active row, we treat the user as 'free'. This prevents a DB hiccup from
 * granting unlimited access, while only causing a minor UX inconvenience for
 * paid users during a transient failure.
 *
 * @param supabase - An authenticated Supabase client (anon or service role)
 * @param userId - The authenticated user's UUID
 * @returns The user's tier ID — 'free' | 'pro' | 'power' — defaulting to 'free'
 */
async function resolveUserTier(supabase: SupabaseClient, userId: string): Promise<TierId> {
  const { data: subscription, error } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (error || !subscription?.tier) {
    // WHY: Fail-closed. Any lookup failure → treat as free tier.
    return 'free';
  }

  // Narrow to the three tiers polar.ts knows about. Any unknown value falls
  // back to 'free' so future tiers in the DB don't accidentally grant full access.
  const knownTiers: TierId[] = ['free', 'pro', 'power'];
  const resolved = subscription.tier as string;
  return knownTiers.includes(resolved as TierId) ? (resolved as TierId) : 'free';
}

/**
 * Counts the number of sessions the user has started in the past 24 hours.
 *
 * WHY interval '1 day': Rolling window rather than midnight-reset so a user
 * who starts 5 sessions at 11 PM cannot immediately start 5 more at midnight.
 *
 * @param supabase - An authenticated Supabase client
 * @param userId - The authenticated user's UUID
 * @returns Session count over the last 24 hours, or 0 on error
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
 * WHY COUNT(*): Each row in agent_configs represents one configured agent type.
 * The unique constraint on (user_id, agent_type) ensures no double-counting.
 *
 * @param supabase - An authenticated Supabase client
 * @param userId - The authenticated user's UUID
 * @returns Number of configured agents, or 0 on error
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
 * Checks whether a user has exceeded their tier's limit for a given resource.
 *
 * This is the single authoritative enforcement point for SEC-LOGIC-002. Call
 * it at the start of any API handler that creates a session or agent config
 * before performing any DB writes.
 *
 * Edge cases handled:
 * - `Infinity` limits (pro/power for sessions) → always allowed, no DB query
 * - Tier lookup failure → defaults to 'free' (fail-closed)
 * - Count query failure → returns 0 (fail-open for counting, fail-closed on tier)
 *
 * @param userId - The authenticated user's UUID
 * @param limitType - Which resource limit to check
 * @param supabase - An authenticated Supabase client instance
 * @returns `{ allowed: true }` or `{ allowed: false, limit, current, tier, upgradeUrl }`
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
  // Resolve tier first — needed to determine the limit and whether to even count.
  const tier = await resolveUserTier(supabase, userId);

  // Look up the limit for this tier. TIER_LIMITS covers 'free' | 'pro' | 'power' | 'team'.
  // We resolved tier to one of 'free' | 'pro' | 'power' above, all of which are present.
  const tierLimits = TIER_LIMITS[tier as keyof typeof TIER_LIMITS];
  const limit = tierLimits[limitType] as number;

  // WHY early return: Infinity means unlimited (pro/power for sessions).
  // Skip the DB count entirely to save a round-trip.
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
