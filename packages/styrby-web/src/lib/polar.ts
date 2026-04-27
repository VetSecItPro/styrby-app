/**
 * Polar Integration — server-side SDK client + checkout / subscription helpers.
 *
 * WHY this file is server-only territory:
 *   The `new Polar({ accessToken: process.env.POLAR_ACCESS_TOKEN })` call below
 *   is a side-effect at module load. If this module is pulled into a `'use
 *   client'` import chain, the SDK class is bundled client-side (the env var
 *   resolves to undefined in the browser, but the SDK weight ships anyway).
 *
 *   The pure-data tier configuration (TIERS, types, helpers) was extracted to
 *   `@/lib/billing/tier-config` so client components can import tier
 *   constants without dragging in the SDK. This module re-exports those for
 *   backward compatibility with existing server-side callers.
 *
 *   Surfaced by /perf focused-delta scan (BUNDLE-001, 2026-04-25).
 *
 *   Future hardening: add `import 'server-only'` to make a client-side import
 *   fail at build time. Requires `pnpm add server-only` first.
 */

import { Polar } from '@polar-sh/sdk';

// Re-export tier configuration for backward compatibility with server-side
// callers that import from '@/lib/polar' (13 server files as of 2026-04-25).
// Client-side callers should import directly from '@/lib/billing/tier-config'.
export { TIERS, getTier, getProductId, getDisplayPrice } from './billing/tier-config';
export type { TierId, BillingCycle } from './billing/tier-config';

/**
 * Styrby billing policy: NO proration, NO mid-cycle refunds.
 *
 * All subscription changes (tier downgrades, seat-addon cancellations,
 * subscription cancellations) take effect at the END of the current billing
 * period. The customer keeps what they paid for through the period, then the
 * change applies on the next renewal.
 *
 * WHY a per-API-call constant (and not just a Polar dashboard org setting):
 *   Polar's org-level proration default may be "prorate" or differ between
 *   sandbox and production. Passing `prorationBehavior` on every
 *   `subscriptions.update` call overrides the org default for code-initiated
 *   changes. Customer-portal-initiated changes still follow the dashboard
 *   setting, so the dashboard org setting must ALSO be set to "next_period"
 *   in both sandbox.polar.sh and polar.sh org settings to keep the policy
 *   consistent across all change paths.
 *
 * Bug #6 reference: a missing `prorationBehavior` argument on
 * `cancelSubscription()` previously meant Polar's default applied — which
 * could issue partial refunds when the dashboard default drifted from
 * "next_period". This constant hardcodes the policy at the call site.
 */
export const STYRBY_PRORATION_BEHAVIOR = 'next_period' as const;

/**
 * Resolve which Polar backend the SDK should talk to.
 *
 *   "sandbox"    → https://sandbox-api.polar.sh (test cards, no real money)
 *   "production" → https://api.polar.sh         (default, real money)
 *
 * Sandbox and production are completely separate accounts at Polar — the
 * access token, org, products, and webhooks all differ. Set POLAR_ENV=sandbox
 * (in .env.sandbox or a Vercel preview env) along with sandbox values for
 * `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, and `POLAR_*_PRODUCT_ID` to
 * exercise the full checkout/webhook lifecycle without real charges.
 *
 * @returns The Polar server target — `"sandbox"` when `POLAR_ENV` is set to
 *   the literal string `"sandbox"`, otherwise `"production"` (default).
 *
 * @example
 *   POLAR_ENV=sandbox  → getPolarServer() === "sandbox"
 *   POLAR_ENV=prod     → getPolarServer() === "production"  (anything not "sandbox")
 *   (unset)            → getPolarServer() === "production"
 */
export function getPolarServer(): 'production' | 'sandbox' {
  return process.env.POLAR_ENV === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Polar SDK client instance.
 *
 * Uses server-side access token for API operations and routes traffic to
 * sandbox or production based on `POLAR_ENV` (see `getPolarServer`).
 */
export const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: getPolarServer(),
});

/**
 * Resolve the Polar product ID for the Team-seat add-on at the given billing
 * interval. The team-seat add-on is a per-seat upcharge attached to Team /
 * Business plans (e.g. $20/seat/mo) — distinct from the base subscription
 * product.
 *
 * @param interval - Billing cycle: `"monthly"` or `"annual"`.
 * @returns The Polar product ID from the matching env var, or `null` when
 *   the env var is unset/empty (e.g. seat add-on not yet provisioned in
 *   that environment).
 *
 * @example
 *   getTeamSeatProductId('monthly') // → process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID
 *   getTeamSeatProductId('annual')  // → process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID
 */
export function getTeamSeatProductId(interval: 'monthly' | 'annual'): string | null {
  return interval === 'annual'
    ? process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID || null
    : process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID || null;
}

/**
 * Test whether a given Polar product ID corresponds to the Team-seat add-on
 * (either monthly or annual variant). Used in webhook handlers and seat-
 * accounting code to distinguish base subscription products from the
 * per-seat add-on so they can be reconciled separately.
 *
 * @param productId - A Polar product ID (e.g. from a webhook payload).
 * @returns `true` when the product ID matches either of the two configured
 *   `POLAR_GROWTH_SEAT_*` env vars; `false` otherwise.
 *
 * @example
 *   isTeamSeatProduct('prod_seat_mo_abc') // → true if env matches
 *   isTeamSeatProduct('prod_pro_mo_xyz')  // → false (base plan, not a seat)
 */
export function isTeamSeatProduct(productId: string): boolean {
  if (!productId) return false;
  return (
    productId === process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID ||
    productId === process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID
  );
}

/**
 * Create a checkout session for subscription.
 */
export async function createCheckoutSession(
  productId: string,
  customerId: string,
  successUrl: string,
  _cancelUrl?: string
) {
  const checkout = await polar.checkouts.create({
    productId,
    successUrl,
    customerEmail: customerId, // Will be mapped to customer
    metadata: {
      userId: customerId,
    },
  });

  return checkout;
}

/**
 * Get customer portal URL for managing subscription.
 *
 * WHY: Polar does not currently expose a customer-specific portal URL via
 * their SDK (as of Feb 2026). We link to the subscriptions page instead of
 * the generic settings page so users land closer to where they can manage
 * their plan. They will need to be logged into Polar for this to work.
 *
 * @param customerId - The Polar customer ID (reserved for future API use)
 * @returns URL to the Polar subscriptions management page
 *
 * WHY generic link: Polar does not yet expose a `customers.createPortalSession()`
 * API. When they do, replace this with a customer-specific portal URL.
 * Track: https://github.com/polarsource/polar/issues
 */
export async function getCustomerPortalUrl(_customerId: string) {
  return `https://polar.sh/purchases/subscriptions`;
}

/**
 * Cancel a Polar subscription. Defaults to cancel-at-period-end (the user
 * retains paid access through `current_period_end`), with an optional
 * `immediate: true` flag for hard-revoke (e.g. account deletion / fraud).
 *
 * WHY cancel-at-period-end (default): The user retains full access to their
 * paid tier until `current_period_end`, then Polar fires `subscription.canceled`
 * which our handler records as `status: 'canceled'` in Supabase. A scheduled
 * cron job downgrades the tier to `free` once the period expires.
 *
 * WHY NOT revoke() by default: `revoke()` cancels immediately - the user loses
 * access right now even though they paid for the rest of the period. That's a
 * billing violation and a trust/churn problem. Cancel-at-period-end is the
 * industry default (Stripe, Lemon Squeezy, Paddle).
 *
 * WHY pass `prorationBehavior: STYRBY_PRORATION_BEHAVIOR` (Bug #6 fix):
 *   Polar's org-level default may differ between sandbox and production, and
 *   may drift over time. Hardcoding `next_period` at the call site guarantees
 *   no partial refunds are issued for code-initiated cancellations regardless
 *   of dashboard configuration. The `immediate: true` branch uses `revoke`
 *   which intentionally bypasses proration (the whole point of revoke is
 *   instant termination).
 *
 * Webhook flow after the default (cancel-at-period-end) call:
 *   1. Polar fires `subscription.updated` with `cancel_at_period_end: true`
 *      → our handler upserts `cancel_at_period_end: true` into the row
 *   2. At period end, Polar fires `subscription.canceled`
 *      → our handler sets `status: 'canceled'` and preserves `current_period_end`
 *   3. Cron detects `status = 'canceled' AND current_period_end < NOW()`
 *      → downgrades tier to `free`
 *
 * @param subscriptionId - The Polar subscription ID to cancel.
 * @param options - Cancellation options.
 * @param options.immediate - When `true`, hard-revoke instead of cancel-at-period-end.
 *   Reserved for account deletion and fraud workflows. Defaults to `false`.
 * @returns The updated subscription object from Polar.
 * @throws {Error} When the subscription ID is invalid or already canceled.
 *
 * @example
 *   await cancelSubscription('sub_123');                       // cancel at period end (normal)
 *   await cancelSubscription('sub_123', { immediate: true });  // hard revoke (account deletion)
 */
export async function cancelSubscription(
  subscriptionId: string,
  options: { immediate?: boolean } = {},
) {
  // WHY the cast: Polar's REST API accepts the proration values
  // "invoice" | "prorate" | "next_period" | "reset" (per Polar dashboard +
  // OpenAPI docs), but `@polar-sh/sdk@0.29.x`'s generated TS enum only
  // narrows to "invoice" | "prorate". The wire value `next_period` is still
  // honored by the API — this cast bridges the SDK type lag to the runtime
  // contract. Drop the cast once the SDK ships the broader enum (tracked
  // alongside Bug #6 / Phase H7 sandbox parity).
  const subscriptionUpdate: Parameters<typeof polar.subscriptions.update>[0]['subscriptionUpdate'] = options.immediate
    ? { revoke: true as const }
    : // SDK enum lag — see WHY note above the function body.
      ({
        cancelAtPeriodEnd: true,
        prorationBehavior: STYRBY_PRORATION_BEHAVIOR,
      } as unknown as Parameters<typeof polar.subscriptions.update>[0]['subscriptionUpdate']);

  const subscription = await polar.subscriptions.update({
    id: subscriptionId,
    subscriptionUpdate,
  });

  return subscription;
}

/**
 * Get subscription details by ID.
 *
 * Used to display current plan details in the settings page and to verify
 * subscription status before performing tier-gated operations.
 *
 * @param subscriptionId - The Polar subscription ID to retrieve
 * @returns The full subscription object including status, dates, and product info
 * @throws {Error} When the subscription ID is invalid or not found
 */
export async function getSubscription(subscriptionId: string) {
  const subscription = await polar.subscriptions.get({
    id: subscriptionId,
  });

  return subscription;
}

