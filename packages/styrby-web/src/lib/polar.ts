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
 * - Bookmarks: saved sessions per user
 * - PromptTemplates: user-created context templates (-1 = unlimited)
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
      '3 agents: Claude Code, Codex, Gemini CLI',
      'Cost dashboard',
      '1 budget alert',
      'E2E encryption',
      'Push notifications',
      'Offline queue',
      'Device pairing',
    ],
    limits: {
      machines: 1,
      historyDays: 7,
      messagesPerMonth: 1_000,
      budgetAlerts: 1,
      webhooks: 0,
      teamMembers: 1,
      apiKeys: 0,
      /** Maximum saved session bookmarks. */
      bookmarks: 5,
      /** Maximum user-created prompt templates. */
      promptTemplates: 3,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: {
      monthly: 24,
      annual: 240,
    },
    polarProductId: {
      monthly: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_PRO_ANNUAL_PRODUCT_ID,
    },
    features: [
      '3 connected machines',
      '90-day session history',
      '25,000 messages/month',
      'All 9 agents (adds OpenCode, Aider, Goose, Amp, Crush, Kilo)',
      'All push notifications',
      '3 budget alerts',
      'Export and import',
      'Full cost analytics',
      'Email support',
    ],
    limits: {
      machines: 3,
      historyDays: 90,
      messagesPerMonth: 25_000,
      budgetAlerts: 3,
      webhooks: 3,
      teamMembers: 1,
      apiKeys: 0,
      /** Maximum saved session bookmarks. */
      bookmarks: 50,
      /** Maximum user-created prompt templates. */
      promptTemplates: 20,
    },
  },
  power: {
    id: 'power',
    name: 'Power',
    price: {
      monthly: 59,
      annual: 590,
    },
    polarProductId: {
      monthly: process.env.POLAR_POWER_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_POWER_ANNUAL_PRODUCT_ID,
    },
    features: [
      '9 connected machines',
      '1-year session history',
      '100,000 messages/month',
      'All 11 agents (adds Kiro and Droid)',
      'Custom notification rules',
      '5 budget alerts',
      'Per-message cost tracking',
      'Session checkpoints',
      'Session sharing',
      'Per-file context breakdown',
      'Activity graph',
      'Team management (up to 3 members)',
      'OTEL export (Grafana, Datadog, and more)',
      'Voice commands',
      'Cloud monitoring',
      'Code review from mobile',
      '10 webhooks',
      'API access (read-only)',
      'CSV + JSON export',
      'Email support',
    ],
    limits: {
      machines: 9,
      historyDays: 365,
      messagesPerMonth: 100_000,
      budgetAlerts: 5,
      webhooks: 10,
      teamMembers: 3,
      apiKeys: 5,
      /** Maximum saved session bookmarks. -1 means unlimited. */
      bookmarks: -1,
      /** Maximum user-created prompt templates. -1 means unlimited. */
      promptTemplates: -1,
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
 * TODO: Polar may add a `customers.createPortalSession()` or similar API
 * in the future. When available, use it to generate a customer-specific
 * portal URL instead of this generic link. Track:
 * https://github.com/polarsource/polar/issues
 */
export async function getCustomerPortalUrl(_customerId: string) {
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
