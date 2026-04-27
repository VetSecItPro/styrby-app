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
 * affected client importer was `src/app/pricing/pricing-cards.tsx` — public
 * facing marketing page where any saved bytes ship to every visitor.
 *
 * Server callers should continue importing from `@/lib/polar`; that module
 * re-exports from this file, preserving the established API surface.
 *
 * ---------------------------------------------------------------------------
 * 2026-04-27 — Tier reconciliation refactor (Phase 5)
 * ---------------------------------------------------------------------------
 *
 * Styrby converged from a 4-tier model (Free / Pro $24 / Power $49 / Team)
 * to a 2-tier paid model: Pro ($39 individual) + Growth ($99 base + $19/seat
 * after 3, team). Free is preserved as a non-paid fallback for users who
 * have not yet started a trial or whose subscription has lapsed.
 *
 * Canonical decision: see `.audit/styrby-fulltest.md` Decision #1 / #2 / #3.
 *
 * Legacy keys (`power`, `team`, `business`, `enterprise`) are NOT in TIERS
 * any more. They survive only as DB enum aliases — the runtime gating layer
 * resolves them through `LEGACY_TIER_ALIASES` in `tier-enforcement.ts`.
 * Server callers that previously read `TIERS.power.limits.<x>` should now
 * read `TIERS.growth.limits.<x>` (Phase 5 callsite sweep).
 */

/**
 * Subscription tier configuration.
 *
 * Limits are enforced to prevent abuse:
 * - Machines: Supabase Realtime connections per user.
 * - Messages: Relay bandwidth per user per month.
 * - History: Database storage retention in days.
 * - Bookmarks: saved sessions per user (-1 = unlimited).
 * - PromptTemplates: user-created context templates (-1 = unlimited).
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
  /**
   * Pro tier — individual paid plan.
   *
   * WHY $39/mo: Decision #2 in `.audit/styrby-fulltest.md`. Single fixed-fee
   * Polar product per interval. Replaces the old $24 Pro AND $49 Power tiers.
   *
   * `POLAR_PRO_MONTHLY_PRODUCT_ID` env var is preserved across the rename;
   * during Phase 3 cutover its value swaps from the old $24 Pro UUID to the
   * new $39 Pro UUID (`18d19753-0545-4482-8273-83254170d83c`). The code
   * change does NOT need to coordinate with the Vercel env update because
   * the variable name is stable.
   */
  pro: {
    id: 'pro',
    name: 'Pro',
    price: {
      monthly: 39,
      annual: 390,
    },
    polarProductId: {
      monthly: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_PRO_ANNUAL_PRODUCT_ID,
    },
    features: [
      'All 11 CLI agents in one mobile app',
      'Unlimited sessions',
      '1-year session history',
      'Token-level cost attribution',
      'Budget caps + per-alert thresholds',
      'Session checkpoints + replay',
      'OTEL export to Grafana, Datadog, Honeycomb, New Relic',
      'BYOK across every model provider',
      'Push notifications + offline queue',
      'API access + webhooks',
      'Email support',
    ],
    limits: {
      machines: 9,
      historyDays: 365,
      messagesPerMonth: 100_000,
      budgetAlerts: 5,
      webhooks: 10,
      teamMembers: 1,
      apiKeys: 5,
      /** Maximum saved session bookmarks. -1 means unlimited. */
      bookmarks: -1,
      /** Maximum user-created prompt templates. -1 means unlimited. */
      promptTemplates: -1,
    },
  },
  /**
   * Growth tier — team paid plan.
   *
   * WHY $99/mo base + $19/seat after 3: Decision #3 / #4 in
   * `.audit/styrby-fulltest.md`. Mirrors Kaulby's multi-product Path A
   * pattern exactly. The base product covers 3 seats; the seat-addon product
   * is consumed via `getTeamSeatProductId` in `lib/polar.ts` (PR #184) for
   * seats 4+.
   *
   * Annual: $990 base ($82.50 effective base / mo) — see Decision #4.
   *
   * `POLAR_GROWTH_*` env vars are referenced now; they will be populated on
   * Vercel during Phase H12 production cutover. If unset (e.g., the gap
   * between this PR shipping and Phase H12), `getProductId('growth', ...)`
   * returns `undefined` and the paywall surface degrades gracefully — the
   * pricing UI still renders (price strings live on `tier.price`, not on
   * `polarProductId`).
   */
  growth: {
    id: 'growth',
    name: 'Growth',
    price: {
      monthly: 99,
      annual: 990,
    },
    polarProductId: {
      monthly: process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID,
      annual: process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID,
    },
    features: [
      'Everything in Pro, plus:',
      'Team workspace (3 seats included; +$19/seat after)',
      'Per-developer cost rollup with role-based access',
      'Approval chains for risky CLI commands',
      'Full audit trail export (SOC2 / ISO 27001 ready)',
      'Shared budget caps and dashboards',
      'Centralised invite flow with seat-cap enforcement',
      'Priority email support, response within one business day',
    ],
    limits: {
      machines: 9,
      historyDays: 365,
      messagesPerMonth: 100_000,
      budgetAlerts: 5,
      webhooks: 10,
      teamMembers: 100,
      apiKeys: 5,
      /** Maximum saved session bookmarks. -1 means unlimited. */
      bookmarks: -1,
      /** Maximum user-created prompt templates. -1 means unlimited. */
      promptTemplates: -1,
    },
  },
} as const;

/**
 * Tier identifiers known to the public-facing config.
 *
 * Legacy DB enum values (`power`, `team`, `business`, `enterprise`) are
 * resolved at the gating layer via `LEGACY_TIER_ALIASES` and never appear
 * in this type.
 */
export type TierId = keyof typeof TIERS;
export type BillingCycle = 'monthly' | 'annual';

/**
 * Get tier configuration by ID.
 *
 * Defaults to the Free tier on any unrecognised input so callers can never
 * accidentally read paid limits for a malformed value (SOC2 CC6.1 — fail
 * closed on logical access).
 */
export function getTier(tierId: TierId) {
  return TIERS[tierId] || TIERS.free;
}

/**
 * Get product ID for a tier and billing cycle.
 *
 * Returns `undefined` for the free tier (no Polar product) and `undefined`
 * when called from a client component (env vars are server-only). Returns
 * `undefined` when the matching env var is not yet populated (e.g. Growth
 * env vars during the H12 cutover gap) — both the unset case (`undefined`)
 * AND the empty-string case (`''`, which is how Vercel projects a "set but
 * empty" env var) normalize to `undefined` so callers can branch on a
 * single sentinel.
 *
 * WHY normalise empty string → undefined: previously this helper returned
 * `''` when the env var was set-but-empty, which is truthy-coercion-prone
 * and silently disagreed with the JSDoc contract. Aligning the impl with
 * the signature (`string | undefined`) prevents `?.` and `||` callers from
 * routing the empty string into a Polar API call. Surfaced by /test-ship
 * audit (TEST-003, 2026-04-27).
 */
export function getProductId(tierId: TierId, cycle: BillingCycle): string | undefined {
  const tier = TIERS[tierId];
  if (!tier || tierId === 'free') return undefined;
  const id = tier.polarProductId[cycle];
  return id ? id : undefined;
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
