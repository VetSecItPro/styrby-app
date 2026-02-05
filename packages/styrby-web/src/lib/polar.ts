/**
 * Polar Integration
 *
 * Client for Polar billing and subscription management.
 */

import { Polar } from '@polar-sh/sdk';

/**
 * Polar client instance.
 * Uses server-side access token for API operations.
 */
export const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

/**
 * Subscription tier configuration.
 *
 * Limits are enforced to prevent abuse:
 * - Machines: Supabase Realtime connections
 * - Messages: Relay bandwidth
 * - History: Database storage
 */
export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price: {
      monthly: 0,
      annual: 0,
    },
    polarProductId: {
      monthly: undefined as string | undefined,
      annual: undefined as string | undefined,
    },
    features: [
      '1 connected machine',
      '7-day session history',
      '1,000 messages/month',
      'Error notifications only',
      'All 3 agents supported',
    ],
    limits: {
      machines: 1,
      historyDays: 7,
      messagesPerMonth: 1_000,
      budgetAlerts: 0,
      teamMembers: 1,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: {
      monthly: 19,
      annual: 190,
    },
    polarProductId: {
      monthly: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_PRO_ANNUAL_PRODUCT_ID,
    },
    features: [
      '5 connected machines',
      '90-day session history',
      '25,000 messages/month',
      'All push notifications',
      '3 budget alerts',
      'Full cost analytics',
      'CSV export',
      'Email support',
    ],
    limits: {
      machines: 5,
      historyDays: 90,
      messagesPerMonth: 25_000,
      budgetAlerts: 3,
      teamMembers: 1,
    },
  },
  power: {
    id: 'power',
    name: 'Power',
    price: {
      monthly: 49,
      annual: 490,
    },
    polarProductId: {
      monthly: process.env.POLAR_POWER_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_POWER_ANNUAL_PRODUCT_ID,
    },
    features: [
      '15 connected machines',
      '1-year session history',
      '100,000 messages/month',
      'Custom notification rules',
      '10 budget alerts',
      'Up to 5 team members',
      'API access (read-only)',
      'CSV + JSON export',
      'Priority email support',
    ],
    limits: {
      machines: 15,
      historyDays: 365,
      messagesPerMonth: 100_000,
      budgetAlerts: 10,
      teamMembers: 5,
    },
  },
} as const;

export type TierId = keyof typeof TIERS;
export type BillingCycle = 'monthly' | 'annual';

/**
 * Get tier configuration by ID.
 */
export function getTier(tierId: TierId) {
  return TIERS[tierId] || TIERS.free;
}

/**
 * Get product ID for a tier and billing cycle.
 */
export function getProductId(tierId: TierId, cycle: BillingCycle): string | undefined {
  const tier = TIERS[tierId];
  if (!tier || tierId === 'free') return undefined;
  return tier.polarProductId[cycle];
}

/**
 * Get display price for a tier and billing cycle.
 */
export function getDisplayPrice(tierId: TierId, cycle: BillingCycle): { amount: number; period: string } {
  const tier = TIERS[tierId];
  if (cycle === 'annual') {
    return { amount: tier.price.annual, period: '/year' };
  }
  return { amount: tier.price.monthly, period: '/month' };
}

/**
 * Create a checkout session for subscription.
 */
export async function createCheckoutSession(
  productId: string,
  customerId: string,
  successUrl: string,
  cancelUrl?: string
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
 * TODO: Polar may add a `customers.createPortalSession()` or similar API
 * in the future. When available, use it to generate a customer-specific
 * portal URL instead of this generic link. Track:
 * https://github.com/polarsource/polar/issues
 */
export async function getCustomerPortalUrl(customerId: string) {
  return `https://polar.sh/purchases/subscriptions`;
}

/**
 * Cancel a subscription immediately.
 *
 * WHY: Uses Polar's `revoke()` method which cancels the subscription immediately
 * (not at period end). The user's access is revoked and they are downgraded to
 * the free tier. The Polar webhook handler syncs this change to Supabase.
 *
 * @param subscriptionId - The Polar subscription ID to cancel
 * @returns The revoked subscription object from Polar
 * @throws {Error} When the subscription ID is invalid or already canceled
 */
export async function cancelSubscription(subscriptionId: string) {
  const subscription = await polar.subscriptions.revoke({
    id: subscriptionId,
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
