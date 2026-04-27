'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useMonthlySpend } from './use-monthly-spend';
import type { Subscription } from './types';

/** Props for the Subscription section. */
export interface SettingsSubscriptionProps {
  /** Current subscription row (null for truly-free users pre-row-insert). */
  subscription: Subscription | null;
}

/**
 * Subscription section: current tier, renew/cancel date, month-to-date usage
 * bar, and the single "Upgrade" or "Manage" CTA that routes free users to
 * /pricing and paid users to the Polar billing portal.
 *
 * WHY the usage bar fetch lives here (not in the orchestrator): This is the
 * only section that needs monthly spend data, so co-locating the hook keeps
 * the fetch scoped and cancellable with the section's unmount.
 */
export function SettingsSubscription({ subscription }: SettingsSubscriptionProps) {
  const router = useRouter();
  const supabase = createClient();
  const isPaidTier = subscription?.tier === 'pro' || subscription?.tier === 'growth';
  const monthlySpend = useMonthlySpend(supabase, isPaidTier);

  const isFree = subscription?.tier === 'free' || !subscription;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Subscription</h2>
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-semibold text-zinc-100 capitalize">
                {subscription?.tier || 'Free'} Plan
              </p>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  subscription?.status === 'active'
                    ? 'bg-green-500/10 text-green-400'
                    : subscription?.status === 'trialing'
                      ? 'bg-blue-500/10 text-blue-400'
                      : 'bg-zinc-700 text-zinc-400'
                }`}
              >
                {subscription?.status || 'Free'}
              </span>
            </div>
            {subscription?.current_period_end && (
              <p className="text-sm text-zinc-500 mt-1">
                {subscription.cancel_at_period_end ? 'Cancels' : 'Renews'} on{' '}
                {new Date(subscription.current_period_end).toLocaleDateString()}
              </p>
            )}
          </div>
          <button
            onClick={() => {
              if (isFree) {
                router.push('/pricing');
              } else {
                // WHY: The /api/billing/portal route performs Polar customer
                // lookup server-side before the redirect, so we hit it with a
                // full location change rather than client routing.
                window.location.href = '/api/billing/portal';
              }
            }}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label={isFree ? 'Upgrade subscription' : 'Manage subscription'}
          >
            {isFree ? 'Upgrade' : 'Manage'}
          </button>
        </div>

        {subscription && subscription.tier !== 'free' && monthlySpend !== null && (
          <div className="mt-4 pt-4 border-t border-zinc-800">
            <p className="text-sm text-zinc-500">
              This month&apos;s usage: ${monthlySpend.toFixed(2)}
            </p>
            <div className="mt-2 h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-orange-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(monthlySpend * 2, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
