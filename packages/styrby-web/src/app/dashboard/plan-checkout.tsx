'use client';

/**
 * Plan Checkout Trigger
 *
 * Reads ?plan=pro or ?plan=power from the URL and initiates a Polar
 * checkout session. Used when a user signs up from a pricing CTA
 * and lands on the dashboard for the first time.
 *
 * Renders nothing visible. Triggers checkout API call on mount,
 * then redirects to Polar's hosted checkout page.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

// WHY: post-Phase-5 reconciliation. `'power'` is preserved as a legacy URL
// alias (Decision #9 in `.audit/styrby-fulltest.md`) for any pre-existing
// backlinks; the checkout API resolves it to `'growth'` server-side.
const VALID_PLANS = ['pro', 'growth', 'power', 'team'];

export function PlanCheckout() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const triggered = useRef(false);

  const plan = searchParams.get('plan');

  useEffect(() => {
    if (!plan || !VALID_PLANS.includes(plan) || triggered.current) return;
    triggered.current = true;

    async function startCheckout() {
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tierId: plan, billingCycle: 'monthly' }),
        });

        if (res.ok) {
          const { url } = await res.json();
          if (url) {
            window.location.href = url;
            return;
          }
        }

        // Checkout failed; clear the plan param and stay on dashboard
        router.replace('/dashboard');
      } catch {
        router.replace('/dashboard');
      }
    }

    startCheckout();
  }, [plan, router]);

  return null;
}
