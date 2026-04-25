/**
 * Tier Configuration — pure data, no SDK dependency.
 *
 * WHY this file exists separately from `@/lib/polar`:
 * `lib/polar.ts` instantiates the Polar SDK (`new Polar({...})`) at module
 * scope. Importing TIERS/types/helpers from `lib/polar` from a `'use client'`
 * component pulls the entire Polar SDK into the client bundle even though
 * `POLAR_ACCESS_TOKEN` is undefined at runtime in the browser. This file
 * extracts the pure-data tier configuration so client components can import
 * tier constants without dragging in the SDK.
 *
 * Surfaced by /perf focused-delta scan (BUNDLE-001, 2026-04-25). The only
 * affected client importer was `src/app/pricing/pricing-cards.tsx` — public-
 * facing marketing page where any saved bytes ship to every visitor.
 *
 * Server callers should continue importing from `@/lib/polar`; that module
 * now re-exports from this file, preserving the established API surface.
 */

/**
 * Subscription tier configuration.
 *
 * Limits are enforced to prevent abuse:
 * - Machines: Supabase Realtime connections
 * - Messages: Relay bandwidth
 * - History: Database storage
 * - Bookmarks: saved sessions per user
 * - PromptTemplates: user-created context templates (-1 = unlimited)
 *
 * NOTE: `polarProductId` reads `process.env.POLAR_*_PRODUCT_ID` env vars.
 * These are NOT `NEXT_PUBLIC_`-prefixed, so client-side reads resolve to
 * `undefined`. That is intentional — only server code calls `getProductId()`
 * to drive checkout. The pricing UI renders price strings (which live on
 * `tier.price`, not on `polarProductId`).
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
 *
 * Returns undefined for the free tier (no Polar product) and undefined when
 * called from a client component (env vars are server-only).
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
