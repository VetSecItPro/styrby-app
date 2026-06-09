/**
 * useSubscriptionTier — Returns the authenticated user's subscription tier.
 *
 * WHY: Several settings sub-screens (Notifications smart-filter gate, Metrics
 * Export OTEL Power-tier gate, Account subscription row) need to know whether
 * the user is on free / pro / power. Today this lookup is duplicated across
 * multiple components. This hook centralizes it, defaults to 'free' when no
 * subscriptions row exists, and caches the result per component.
 *
 * Extracted in S2 of the Phase 0.6.1 settings refactor.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 4
 */

import { useEffect, useState } from 'react';
import { normalizeTier } from '@styrby/shared/billing';
import { supabase } from '../lib/supabase';

/**
 * Subscription tier values as stored in the `subscriptions.tier` column.
 * Canonical model: docs/planning/styrby-tiers-canonical.md. Active tiers are
 * 'free' | 'pro' | 'growth';
 * WHY the `| string` tail: Supabase returns raw strings and we want graceful
 * handling of unknown / never-shipped enum values ('team', etc.) without throwing.
 */
export type SubscriptionTier = 'free' | 'pro' | 'growth' | string;

/**
 * Hook: fetches the user's current subscription tier.
 *
 * Returns 'free' while loading and when no row exists, matching the
 * existing settings-screen behavior.
 *
 * @param userId - Authenticated Supabase user id (pass null while unknown)
 * @returns `{ tier, isLoading, error, isPaid }` — `isPaid` is true for pro/power/growth
 *
 * @example
 * const { user } = useCurrentUser();
 * const { tier, isPaid } = useSubscriptionTier(user?.id ?? null);
 * if (!isPaid) return <UpgradeCta />;
 */
export function useSubscriptionTier(userId: string | null): {
  tier: SubscriptionTier;
  isLoading: boolean;
  error: Error | null;
  isPaid: boolean;
} {
  const [tier, setTier] = useState<SubscriptionTier>('free');
  const [isLoading, setIsLoading] = useState<boolean>(userId !== null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setTier('free');
      setIsLoading(false);
      return;
    }
    let isMounted = true;
    setIsLoading(true);
    (async () => {
      try {
        // WHY 'tier' (not 'plan'): the column is `subscriptions.tier`
        // (subscription_tier enum). There is NO `plan` column — selecting it
        // returned a PostgREST 42703 error that the catch below swallowed to
        // 'free', so EVERY mobile user (including paying Pro/Growth customers)
        // was treated as free and locked out of paid features. See
        // docs/planning/styrby-tiers-canonical.md.
        const { data, error: subError } = await supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', userId)
          .maybeSingle();

        if (!isMounted) return;

        if (subError) {
          // WHY: A missing row is not an error — we default to 'free'. Only
          // surface real database errors to callers.
          setError(subError instanceof Error ? subError : new Error(String(subError)));
          setTier('free');
        } else {
          setTier((data?.tier as SubscriptionTier | undefined) ?? 'free');
        }
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setTier('free');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [userId]);

  // Paid = any non-free tier. Normalize FIRST so a stray legacy 'power' value
  // (which folds to 'growth') is recognized as paid rather than falling through
  // a hardcoded pro/growth check. normalizeTier also fail-closes unknown values
  // to 'free', so behavior for pro/growth/free is unchanged.
  const normalized = normalizeTier(tier);
  const isPaid = normalized !== 'free';

  return { tier, isLoading, error, isPaid };
}
