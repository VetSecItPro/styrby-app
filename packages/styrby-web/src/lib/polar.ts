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
 */
export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    polarProductId: undefined as string | undefined,
    features: [
      '1 connected machine',
      '7-day session history',
      'Basic cost tracking',
    ],
    limits: {
      machines: 1,
      historyDays: 7,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 9,
    polarProductId: process.env.POLAR_PRO_PRODUCT_ID,
    features: [
      '5 connected machines',
      'Unlimited session history',
      'Advanced analytics',
      'Budget alerts',
    ],
    limits: {
      machines: 5,
      historyDays: -1, // unlimited
    },
  },
  power: {
    id: 'power',
    name: 'Power',
    price: 29,
    polarProductId: process.env.POLAR_POWER_PRODUCT_ID,
    features: [
      'Unlimited machines',
      'Team sharing',
      'API access',
      'Priority support',
    ],
    limits: {
      machines: -1, // unlimited
      historyDays: -1,
    },
  },
} as const;

export type TierId = keyof typeof TIERS;

/**
 * Get tier configuration by ID.
 */
export function getTier(tierId: TierId) {
  return TIERS[tierId] || TIERS.free;
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
 */
export async function getCustomerPortalUrl(customerId: string) {
  // Polar customer portal is accessed via their dashboard
  // Return a URL that redirects to Polar with the customer context
  return `https://polar.sh/settings`;
}

/**
 * Cancel a subscription.
 * TODO: Implement when needed - check Polar SDK docs for current API.
 */
export async function cancelSubscription(_subscriptionId: string) {
  // Polar SDK API may vary - check current documentation
  // For now, redirect users to customer portal
  throw new Error('Use customer portal for subscription management');
}

/**
 * Get subscription by ID.
 * TODO: Implement when needed - check Polar SDK docs for current API.
 */
export async function getSubscription(_subscriptionId: string) {
  throw new Error('Use customer portal for subscription details');
}
