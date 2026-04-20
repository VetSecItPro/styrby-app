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
import { supabase } from '../lib/supabase';

/**
 * Subscription tier values as stored in `subscriptions.plan`.
 * WHY string alias rather than enum: Supabase returns raw strings and we
 * want graceful handling of unknown / future tiers without throwing.
 */
export type SubscriptionTier = 'free' | 'pro' | 'power' | string;

/**
 * Hook: fetches the user's current subscription tier.
 *
 * Returns 'free' while loading and when no row exists, matching the
 * existing settings-screen behavior.
 *
 * @param userId - Authenticated Supabase user id (pass null while unknown)
 * @returns `{ tier, isLoading, error, isPaid }` — `isPaid` is true for pro+power
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
        const { data, error: subError } = await supabase
          .from('subscriptions')
          .select('plan')
          .eq('user_id', userId)
          .maybeSingle();

        if (!isMounted) return;

        if (subError) {
          // WHY: A missing row is not an error — we default to 'free'. Only
          // surface real database errors to callers.
          setError(subError instanceof Error ? subError : new Error(String(subError)));
          setTier('free');
        } else {
          setTier((data?.plan as SubscriptionTier | undefined) ?? 'free');
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

  const isPaid = tier === 'pro' || tier === 'power';

  return { tier, isLoading, error, isPaid };
}
