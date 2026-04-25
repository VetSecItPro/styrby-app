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
 * Polar SDK client instance.
 * Uses server-side access token for API operations.
 */
export const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

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
 * Cancel a subscription at the end of the current billing period.
 *
 * WHY: Uses Polar's `subscriptions.update()` with `cancelAtPeriodEnd: true`
 * instead of `revoke()`. This means the user retains full access to their
 * paid tier until `current_period_end`, then Polar fires a `subscription.canceled`
 * webhook which our handler picks up and records `status: 'canceled'` in Supabase.
 * A scheduled cron job then downgrades the tier to 'free' once the period expires.
 *
 * WHY NOT revoke(): `revoke()` cancels immediately — the user loses access right
 * now even though they already paid for the rest of the billing period. That is
 * a billing violation and a trust/churn problem. Cancel-at-period-end is the
 * industry-standard behavior (Stripe, Lemon Squeezy, Paddle all default to this).
 *
 * Webhook flow after this call:
 * 1. Polar fires `subscription.updated` with `cancel_at_period_end: true`
 *    → our handler upserts `cancel_at_period_end: true` into the subscriptions row
 * 2. At period end, Polar fires `subscription.canceled`
 *    → our handler sets `status: 'canceled'` and preserves `current_period_end`
 * 3. Cron job detects `status = 'canceled' AND current_period_end < NOW()`
 *    → downgrades tier to 'free'
 *
 * @param subscriptionId - The Polar subscription ID to cancel at period end
 * @returns The updated subscription object from Polar (status still 'active', cancel_at_period_end: true)
 * @throws {Error} When the subscription ID is invalid or already canceled
 */
export async function cancelSubscription(subscriptionId: string) {
  const subscription = await polar.subscriptions.update({
    id: subscriptionId,
    subscriptionUpdate: {
      cancelAtPeriodEnd: true,
    },
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

