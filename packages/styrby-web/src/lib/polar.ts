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
