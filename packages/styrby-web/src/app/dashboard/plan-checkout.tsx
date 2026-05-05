'use client';

/**
 * Plan Checkout Trigger (POST-SIGNUP-2)
 *
 * Reads `?plan=&seats=&billing=` from the URL on dashboard mount and
 * initiates a Polar checkout session. This component is the convergence
 * point for any post-auth flow that needs to drop the user at Polar:
 *
 *   1. **OTP signup → Polar.** The signup page already handles this
 *      inline before pushing to /dashboard, so this component is a no-op
 *      for the OTP path (the params are stripped pre-redirect).
 *   2. **OAuth signup → Polar.** GitHub/Google flows can't run code
 *      between OAuth callback and dashboard, so they land here with the
 *      plan/seats/billing params intact and this component fires the
 *      checkout call. The auth/callback route preserves the query string
 *      via `sanitizeRedirect` (which accepts paths with `?` query parts).
 *   3. **Direct links to `/dashboard?plan=…`** (e.g. legacy email CTAs)
 *      get the same treatment.
 *
 * Wire format matches the discriminated-union schema in
 * `/api/billing/checkout/route.ts`:
 *   - Pro variant: `{ tierId: 'pro', billingCycle }` — no seats
 *   - Growth variant: `{ tierId: 'growth', billingCycle, seats? }`
 *
 * On success → `window.location.href = polarUrl` (cross-origin nav).
 * On failure → `router.replace('/dashboard')` to clear the params so the
 * user can retry from the dashboard upgrade button without re-firing.
 *
 * Renders nothing visible. The `triggered` ref guards against double-fire
 * on the StrictMode double-mount or re-renders triggered by router changes.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

/**
 * Canonical paid tiers accepted by `/api/billing/checkout`. Anything not
 * in this set (and not in {@link LEGACY_PLAN_ALIAS}) is ignored — we never
 * pass an unknown tier through to the API where it would 400 noisily.
 */
const VALID_PLANS = new Set<'pro' | 'growth'>(['pro', 'growth']);

/**
 * Pre-Phase-5 plan slugs that may still be in old marketing links, email
 * CTAs, or bookmarked URLs. Map them to their canonical equivalent so the
 * old link still does the right thing rather than dumping the user at a
 * blank dashboard.
 *
 *   - `power` was the legacy individual paid plan; it collapsed into Pro.
 *     We map it to `growth` here intentionally because `power`'s feature
 *     set was closer to today's Growth (team-ish) than Pro (single seat).
 *     If you want strict-pro behavior for `?plan=power`, change to 'pro'.
 *   - `team` was the legacy seat-based plan; canonical replacement is Growth.
 */
const LEGACY_PLAN_ALIAS: Record<string, 'pro' | 'growth'> = {
  power: 'growth',
  team: 'growth',
};

/**
 * Reads the `seats` URL param. Returns a positive integer in [1, 1000]
 * (defensive ceiling — the API also re-validates against the canonical
 * GROWTH_BASE_SEATS / GROWTH_MAX_SEATS bounds), or `null` for any
 * invalid / missing input. NEVER trusts the value blindly because it
 * arrives from a URL that anyone can craft.
 */
function parseSeatsParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1000) {
    return null;
  }
  return n;
}

export function PlanCheckout() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const triggered = useRef(false);

  const rawPlan = searchParams.get('plan');
  const plan: 'pro' | 'growth' | null = (() => {
    if (!rawPlan) return null;
    if (VALID_PLANS.has(rawPlan as 'pro' | 'growth')) {
      return rawPlan as 'pro' | 'growth';
    }
    return LEGACY_PLAN_ALIAS[rawPlan] ?? null;
  })();

  const seats = parseSeatsParam(searchParams.get('seats'));
  const billingCycle: 'monthly' | 'annual' =
    searchParams.get('billing') === 'annual' ? 'annual' : 'monthly';

  useEffect(() => {
    if (!plan || triggered.current) return;
    triggered.current = true;

    async function startCheckout() {
      try {
        // Build body matching the discriminated union in
        // /api/billing/checkout/route.ts. Sending `seats` for Pro is
        // explicitly rejected by the Pro variant's `.strict()` schema
        // (P1-BILLING-7), so we ONLY include it for Growth.
        const body: Record<string, unknown> =
          plan === 'growth'
            ? { tierId: 'growth', billingCycle, ...(seats ? { seats } : {}) }
            : { tierId: 'pro', billingCycle };

        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const { url } = (await res.json()) as { url?: string };
          if (url) {
            // Cross-origin redirect to Polar's hosted checkout page.
            // window.location is required (not router.push) because Polar
            // is a different origin and Next's router only handles
            // same-origin nav.
            window.location.href = url;
            return;
          }
        }

        // Checkout call failed (server-side validation, missing product,
        // Polar misconfig, etc.) — clear the URL params so this component
        // doesn't re-fire on the next render and the user can retry
        // manually from the dashboard upgrade button.
        router.replace('/dashboard');
      } catch {
        router.replace('/dashboard');
      }
    }

    startCheckout();
  }, [plan, seats, billingCycle, router]);

  return null;
}
