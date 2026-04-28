/**
 * Polar billing product definitions and pricing helpers for the public
 * pricing page.
 *
 * 2026-04-27 — Tier reconciliation refactor (Phase 5).
 *
 * Styrby converged from a 4-tier marketing model (Solo / Team / Business /
 * Enterprise) to a 2-tier paid model: Pro ($39 individual) + Growth ($99
 * base + $19/seat after 3, team). This module is the page-side counterpart
 * to the gating-layer reconciliation in `tier-config.ts` and
 * `tier-enforcement.ts`.
 *
 * Canonical decision: see `.audit/styrby-fulltest.md` Decisions #1 / #2 /
 * #3 / #4 / #12.
 *
 * Pricing math:
 *   - Pro is a fixed $39/mo (or $390/yr) flat fee.
 *   - Growth is a multi-product Path A: a $99/mo base product (covers 3
 *     seats) plus a $19/seat/mo add-on for seats 4+. Annual: $990 base +
 *     $190/seat. The page renders this as "Starting at $99/mo for 3 seats"
 *     and lets the buyer pick a seat count; the seat add-on math is applied
 *     by helpers in this module.
 *
 * Polar product ID env vars (read by `lib/polar.ts` PR #184; referenced
 * here for the `getProductId` helper):
 *   - POLAR_PRO_MONTHLY_PRODUCT_ID
 *   - POLAR_PRO_ANNUAL_PRODUCT_ID
 *   - POLAR_GROWTH_MONTHLY_PRODUCT_ID
 *   - POLAR_GROWTH_ANNUAL_PRODUCT_ID
 *   - POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID
 *   - POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID
 *
 * If any env var is unset (e.g., during the Phase H12 cutover gap), the
 * `getProductId` helper returns `null` and the paywall surface degrades
 * gracefully. The pricing UI still renders price strings (which live on
 * `TIER_DEFINITIONS_CANONICAL`, not on env vars).
 *
 * SOC2 CC7.2 — billing math has a single code path. Any caller that needs
 * to compute a price MUST go through this module.
 *
 * @module billing/polar-products
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Annual billing discount in basis points (100 bps = 1%).
 * 1700 bps = 17% discount on annual vs monthly total.
 *
 * WHY 17%: equivalent to "2 months free" on a 12-month subscription
 * (10/12 ≈ 83.3% of monthly cost → ~16.7% discount, rounded to 17%).
 *
 * WHY basis points (not percentages): bps avoid floating-point representation
 * entirely. `price × (10000 - bps) / 10000` keeps everything in integer
 * arithmetic with `Math.floor` to truncate cents in the customer's favour.
 */
export const ANNUAL_DISCOUNT_BPS = 1700;

/**
 * Growth tier base seat count — the number of seats included in the base
 * product price. Seats above this are billed via the seat add-on product.
 *
 * Decision #3 in `.audit/styrby-fulltest.md`. Mirrors Kaulby's pattern.
 */
export const GROWTH_BASE_SEATS = 3;

/**
 * Growth tier maximum seats sold via the self-serve checkout. Above this
 * we route to the sales team (custom volume pricing).
 *
 * WHY 100: matches the existing slider cap on the team checkout page.
 */
export const GROWTH_MAX_SEATS = 100;

/**
 * Pro tier monthly price in USD cents (Decision #2).
 */
const PRO_MONTHLY_USD_CENTS = 3900;

/**
 * Pro tier annual price in USD cents (Decision #2).
 */
const PRO_ANNUAL_USD_CENTS = 39000;

/**
 * Growth tier base monthly price in USD cents — covers GROWTH_BASE_SEATS
 * (Decision #3).
 */
const GROWTH_BASE_MONTHLY_USD_CENTS = 9900;

/**
 * Growth tier base annual price in USD cents — covers GROWTH_BASE_SEATS
 * (Decision #4).
 */
const GROWTH_BASE_ANNUAL_USD_CENTS = 99000;

/**
 * Growth seat add-on monthly price (Decision #3).
 */
const GROWTH_SEAT_MONTHLY_USD_CENTS = 1900;

/**
 * Growth seat add-on annual price (Decision #4).
 */
const GROWTH_SEAT_ANNUAL_USD_CENTS = 19000;

// ============================================================================
// Tier definitions
// ============================================================================

/**
 * Tier identifiers for the public pricing page.
 *
 * Post-rename (Phase 5) the public pricing page surfaces exactly two paid
 * tiers. Free is rendered separately on the marketing site (it is not a
 * Polar product) and Enterprise is replaced by a "Talk to founders" CTA on
 * the Growth card for any seat count above {@link GROWTH_MAX_SEATS}.
 */
export type PublicTierId = 'pro' | 'growth';

/**
 * Pricing definition for a single tier as rendered on the public pricing page.
 * All monetary amounts are in USD cents (integer).
 */
export interface TierDefinition {
  /** Tier identifier. */
  id: PublicTierId;
  /** Display name. */
  name: string;
  /** One-line marketing description. */
  tagline: string;
  /**
   * Base monthly price in USD cents. For Pro this is the full price (single
   * seat). For Growth this is the price of the base product, which covers
   * {@link GROWTH_BASE_SEATS} seats; additional seats are added via the
   * seat add-on at {@link GROWTH_SEAT_MONTHLY_USD_CENTS}.
   */
  baseMonthlyUsdCents: number;
  /**
   * Per-seat monthly price for seats above the base bundle, in USD cents.
   * 0 for Pro (single-seat plan; this field unused).
   */
  seatPriceMonthlyUsdCents: number;
  /** Number of seats included in the base price. 1 for Pro. */
  baseSeats: number;
  /** Minimum seats sold via self-serve checkout. */
  minSeats: number;
  /** Maximum seats sold via self-serve checkout. */
  maxSeats: number;
  /** Marketing feature bullets. */
  highlights: string[];
  /** CTA button label. */
  cta: string;
  /** Whether to visually highlight this tier as recommended. */
  recommended: boolean;
  /** Checkout entry point URL for this tier. */
  checkoutPath: string;
}

/**
 * Internal canonical-only definitions (Pro / Growth). The exported
 * `TIER_DEFINITIONS` augments this with legacy keys (`solo`, `team`,
 * `business`, `enterprise`) that mirror the Pro / Growth content for
 * back-compat with the unmodified pricing card components. See the
 * "Legacy compatibility shims" section below.
 *
 * Pricing source: `.audit/styrby-fulltest.md` Decisions #2 / #3 / #4.
 */
const CANONICAL_TIER_DEFINITIONS: Record<PublicTierId, TierDefinition> = {
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For developers tired of bouncing between agent dashboards.',
    baseMonthlyUsdCents: PRO_MONTHLY_USD_CENTS,
    seatPriceMonthlyUsdCents: 0,
    baseSeats: 1,
    minSeats: 1,
    maxSeats: 1,
    highlights: [
      'Run all 11 CLI agents in parallel without re-pairing',
      'Unlimited sessions, no per-message overage',
      '1 year of searchable, encrypted session history',
      'Token-level cost attribution across every model',
      'Budget caps that throttle or kill runaway sessions',
      'Session checkpoints, sharing, and replay',
      'OTEL export to Grafana, Datadog, Honeycomb, New Relic',
      'Push notifications and offline command queue',
      'API access and webhooks',
    ],
    cta: 'Start my Pro trial',
    recommended: false,
    checkoutPath: '/signup?plan=pro',
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    tagline: 'For teams that need to see who spent what, and govern who can do what.',
    baseMonthlyUsdCents: GROWTH_BASE_MONTHLY_USD_CENTS,
    seatPriceMonthlyUsdCents: GROWTH_SEAT_MONTHLY_USD_CENTS,
    baseSeats: GROWTH_BASE_SEATS,
    minSeats: GROWTH_BASE_SEATS,
    maxSeats: GROWTH_MAX_SEATS,
    highlights: [
      'Everything in Pro, plus:',
      'Team workspace with role-based access',
      'Per-developer cost rollup with shared dashboards',
      'Approval chains: require team-lead sign-off on risky CLI commands',
      'Full audit trail export, ready for SOC2 and ISO 27001 evidence',
      'Invite flow with email verification and seat-cap enforcement',
      '3 seats included; add seats anytime at $19 each',
      'Priority email support, response within one business day',
    ],
    cta: 'Start my Growth trial',
    recommended: true,
    checkoutPath: '/signup?plan=growth',
  },
};

// ============================================================================
// Pricing math
// ============================================================================

/**
 * Calculates the total monthly cost in USD cents for a given tier and seat
 * count.
 *
 * - For `pro`: returns the fixed monthly price (clamped to 1 seat — Pro is a
 *   single-user plan; any seat count above 1 silently clamps).
 * - For `growth`: returns `baseMonthly + seatPrice × max(0, seats - baseSeats)`.
 *
 * WHY integer math only: multiplying integer cents by an integer seat count
 * always yields an integer. No rounding needed here.
 *
 * @param tierId - The canonical tier identifier (`'pro'` or `'growth'`).
 * @param seatCount - Number of seats. Clamped to tier min/max.
 * @returns Total monthly cost in USD cents.
 *
 * @example
 * ```ts
 * calculateMonthlyCostCents('pro', 1);     // 3900   → $39.00/mo
 * calculateMonthlyCostCents('growth', 3);  // 9900   → $99.00/mo (base only)
 * calculateMonthlyCostCents('growth', 5);  // 13700  → $99 + 2 × $19
 * ```
 */
export function calculateMonthlyCostCents(tierId: PublicTierId, seatCount: number): number {
  const tier = CANONICAL_TIER_DEFINITIONS[tierId];
  const seats = Math.max(tier.minSeats, Math.min(tier.maxSeats, seatCount));

  if (tierId === 'pro') {
    return tier.baseMonthlyUsdCents;
  }

  // Growth: base + addon × extra seats above the included bundle.
  const extraSeats = Math.max(0, seats - tier.baseSeats);
  return tier.baseMonthlyUsdCents + tier.seatPriceMonthlyUsdCents * extraSeats;
}

/**
 * Calculates the total annual cost in USD cents for a given tier and seat
 * count.
 *
 * Pro and Growth both use direct annual product prices (NOT monthly × 12 ×
 * discount), because Polar publishes them as separate products on the
 * dashboard. The annual products bake in the ~17% discount upfront.
 *
 * Growth annual: `baseAnnual + seatAnnualPrice × max(0, seats - baseSeats)`.
 *
 * @param tierId - The canonical tier identifier (`'pro'` or `'growth'`).
 * @param seatCount - Number of seats.
 * @returns Total annual cost in USD cents.
 *
 * @example
 * ```ts
 * calculateAnnualCostCents('pro', 1);      // 39000   → $390/yr
 * calculateAnnualCostCents('growth', 3);   // 99000   → $990/yr (base)
 * calculateAnnualCostCents('growth', 5);   // 137000  → $990 + 2 × $190
 * ```
 */
export function calculateAnnualCostCents(tierId: PublicTierId, seatCount: number): number {
  const tier = CANONICAL_TIER_DEFINITIONS[tierId];
  const seats = Math.max(tier.minSeats, Math.min(tier.maxSeats, seatCount));

  if (tierId === 'pro') {
    return PRO_ANNUAL_USD_CENTS;
  }

  // Growth: annual base + annual seat addon × extra seats above the bundle.
  const extraSeats = Math.max(0, seats - tier.baseSeats);
  return GROWTH_BASE_ANNUAL_USD_CENTS + GROWTH_SEAT_ANNUAL_USD_CENTS * extraSeats;
}

/**
 * Calculates the effective per-month cost when paying annually (display).
 *
 * Used by the pricing page toggle to show "billed annually at $X/mo".
 *
 * @param tierId - The canonical tier identifier (`'pro'` or `'growth'`).
 * @param seatCount - Number of seats.
 * @returns Per-month cost in USD cents when billed annually.
 *
 * @example
 * ```ts
 * calculateAnnualMonthlyEquivalentCents('pro', 1);    // floor(39000/12) = 3250
 * calculateAnnualMonthlyEquivalentCents('growth', 3); // floor(99000/12) = 8250
 * ```
 */
export function calculateAnnualMonthlyEquivalentCents(
  tierId: PublicTierId,
  seatCount: number
): number {
  const annualCents = calculateAnnualCostCents(tierId, seatCount);
  return Math.floor(annualCents / 12);
}

/**
 * Validates that a seat count is within acceptable bounds for a given tier.
 *
 * - Pro: must be exactly 1 (single-user plan).
 * - Growth: must be a positive integer between {@link GROWTH_BASE_SEATS}
 *   and {@link GROWTH_MAX_SEATS} inclusive.
 *
 * @param tierId - The canonical tier identifier (`'pro'` or `'growth'`).
 * @param seatCount - Proposed seat count to validate.
 * @returns `true` if the seat count is valid for the tier.
 */
export function validateSeatCount(tierId: PublicTierId, seatCount: number): boolean {
  if (!Number.isInteger(seatCount)) return false;
  const tier = CANONICAL_TIER_DEFINITIONS[tierId];
  return seatCount >= tier.minSeats && seatCount <= tier.maxSeats;
}

/**
 * Module-scope `Intl.NumberFormat` instances reused across every
 * {@link formatCents} call.
 *
 * WHY hoisted: `Intl.NumberFormat` construction is non-trivial — it parses
 * locale and currency tables on each `new` call. The pricing page can call
 * `formatCents` 20+ times per render (one per tier card pricing line +
 * comparison rows), so re-instantiating per-call burns measurable CPU on
 * the SeatCountSlider drag path (60fps). Constructed once at module load
 * since the locale ('en-US') and currency ('USD') are constants.
 */
const CURRENCY_FORMATTER_NO_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const CURRENCY_FORMATTER_WITH_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats USD cents as a display string.
 *
 * @param cents - Amount in USD cents.
 * @returns Formatted string, e.g. "$39", "$1,900", "$0.50".
 *
 * @example
 * ```ts
 * formatCents(3900);   // "$39"
 * formatCents(190000); // "$1,900"
 * formatCents(50);     // "$0.50"
 * ```
 */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (cents === 0) return '$0';
  if (cents % 100 === 0) {
    return CURRENCY_FORMATTER_NO_CENTS.format(dollars);
  }
  return CURRENCY_FORMATTER_WITH_CENTS.format(dollars);
}

// ============================================================================
// Polar product ID resolution
// ============================================================================

/**
 * Billing interval for Polar products.
 */
export type BillingInterval = 'monthly' | 'annual';

/**
 * Returns the Polar product ID for the BASE product of a given tier and
 * billing interval. Returns `null` if the env var is unset (e.g. during the
 * Phase H12 cutover gap before the Growth products are created on prod).
 *
 * Mirrors the shape of Kaulby's `getProductId` helper exactly.
 *
 * @param plan - The public tier identifier.
 * @param interval - Billing interval (`monthly` | `annual`).
 * @returns Polar product UUID or `null` if not configured.
 */
export function getProductId(plan: PublicTierId, interval: BillingInterval): string | null {
  if (plan === 'pro') {
    return interval === 'annual'
      ? process.env.POLAR_PRO_ANNUAL_PRODUCT_ID || null
      : process.env.POLAR_PRO_MONTHLY_PRODUCT_ID || null;
  }
  if (plan === 'growth') {
    return interval === 'annual'
      ? process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID || null
      : process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID || null;
  }
  return null;
}

/**
 * Canonical `TIER_DEFINITIONS` view, keyed strictly by {@link PublicTierId}.
 * This is the single source of truth for pricing page tier data.
 */
export const TIER_DEFINITIONS_CANONICAL = CANONICAL_TIER_DEFINITIONS;

/**
 * Maps a Polar product ID back to the canonical tier it represents.
 *
 * Recognises BOTH base products (Pro / Growth) AND the Growth seat add-on
 * (which maps back to `growth` because the seat addon is part of the
 * Growth subscription bundle, not a separate tier).
 *
 * Returns `'free'` for any unknown product ID and emits a structured warning
 * (mirrors Kaulby's SEC-LOGIC-001 pattern). Silent fallback masks
 * misconfiguration; the warning ensures any unknown ID is visible in logs.
 *
 * @param productId - The Polar product UUID to resolve.
 * @returns The canonical tier id, or `'free'` for unknown / empty inputs.
 */
export function getPlanFromProductId(productId: string): 'free' | PublicTierId {
  if (!productId) return 'free';

  const proMonthly = process.env.POLAR_PRO_MONTHLY_PRODUCT_ID;
  const proAnnual = process.env.POLAR_PRO_ANNUAL_PRODUCT_ID;
  const growthMonthly = process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID;
  const growthAnnual = process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID;
  const growthSeatMonthly = process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID;
  const growthSeatAnnual = process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID;

  if (productId === proMonthly || productId === proAnnual) return 'pro';
  if (
    productId === growthMonthly ||
    productId === growthAnnual ||
    productId === growthSeatMonthly ||
    productId === growthSeatAnnual
  ) {
    return 'growth';
  }

  // SEC-LOGIC-001: log unknown product IDs — silent fallback masks
  // misconfiguration. We use console.warn (no logger import) to keep this
  // module client-safe; server callers route through `lib/polar.ts` which
  // has its own structured logger wrapping this helper.
  //
  // WHY only the offending id + count (not the full UUID list): the previous
  // payload dumped all six configured Polar product UUIDs on every miss.
  // Even at warn level that ships the full UUID inventory to logs/Sentry on
  // every unknown-id miss, which is unnecessary log volume and unnecessary
  // exposure of internal product identifiers. The unknown id (the actual
  // diagnostic signal) plus a count of configured ids is sufficient to
  // diagnose misconfiguration.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    const configuredCount = [
      proMonthly,
      proAnnual,
      growthMonthly,
      growthAnnual,
      growthSeatMonthly,
      growthSeatAnnual,
    ].filter(Boolean).length;
    console.warn('[billing] Unknown Polar product ID — falling back to free tier', {
      productId,
      configuredCount,
    });
  }
  return 'free';
}
