/**
 * Polar billing product definitions and pricing helpers for the public
 * pricing page.
 *
 * Styrby converged from a 4-tier marketing model (Solo / Team / Business /
 * Enterprise) to a 2-tier paid model: Pro ($39 individual) + Growth (team
 * with tiered seat-based pricing). This module is the page-side counterpart
 * to the gating-layer reconciliation in `tier-config.ts` and
 * `tier-enforcement.ts`.
 *
 * **Pricing model (sandbox-validated against Polar 2026-05-04):**
 *
 *   - **Pro** — single fixed-price product. $39/mo (or $390/yr).
 *   - **Growth** — single product with TIERED seat-based pricing in Polar.
 *     First 3 seats at $33/seat = $99 base. Seats 4-25 at $19/seat.
 *     Annual: $990 base + $190/seat for seats 4+. The full $99-base +
 *     $19/seat-after-3 model is encoded in the Polar product alone.
 *
 *   The pricing math in this module
 *   (`calculateMonthlyCostCents` / `calculateAnnualCostCents`) mirrors
 *   Polar's tiered pricing exactly. Verified across seats=3..25 for both
 *   monthly and annual cycles — every value matches Polar's actual checkout
 *   total_amount to the cent.
 *
 *   The earlier "Path A multi-product (base + per-seat addon)" pattern was
 *   investigated and discarded — Polar's `products: [a, b]` is a tier-picker
 *   not a bundle. See `~/.claude/projects/.../memory/feedback_validate_against_real_apis.md`.
 *
 * **Polar product ID env vars** (read by `tier-config.ts` for product
 * resolution):
 *   - POLAR_PRO_MONTHLY_PRODUCT_ID
 *   - POLAR_PRO_ANNUAL_PRODUCT_ID
 *   - POLAR_GROWTH_MONTHLY_PRODUCT_ID
 *   - POLAR_GROWTH_ANNUAL_PRODUCT_ID
 *
 * `POLAR_GROWTH_SEAT_*_PRODUCT_ID` env vars and the corresponding "Styrby
 * Growth Seat" Polar products are VESTIGIAL — the webhook reconciler
 * (`api/webhooks/polar/route.ts`) still maps them to `tier='growth'` for
 * back-compat with any historical subscriptions, but new checkouts must
 * NOT include them. Cleanup tracked in CLEANUP-1.
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
 * WHY 25: caps self-serve at the size where standard SaaS pricing fits cleanly.
 * Teams above 25 are typically procurement-driven and want negotiated terms,
 * volume discount, and an MSA — not a one-click checkout. Routing them to
 * sales avoids leaving money on the table from larger contracts that would
 * have negotiated down from list anyway.
 */
export const GROWTH_MAX_SEATS = 25;

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
      'On-demand session summaries: hit one button, get the rundown',
      'Weekly digest of your AI\'s work, delivered Sunday morning',
      'Session checkpoints, sharing, and replay',
      'OTEL export to Grafana, Datadog, Honeycomb, New Relic',
      'Push notifications and offline command queue',
      'API access and webhooks',
    ],
    cta: 'Start with Pro',
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
      'Daily digest every morning, with the team-wide rollup',
      'Approval chains: require team-lead sign-off on risky CLI commands',
      'Full audit trail export, ready for SOC2 and ISO 27001 evidence',
      'Invite flow with email verification and seat-cap enforcement',
      '3 seats included; add seats anytime at $19 each',
      'Priority email support, response within one business day',
    ],
    cta: 'Start with Growth',
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
 * Detailed result of {@link validateSeatCountResult} — a discriminated union so
 * callers can surface a specific failure reason + the tier minimum to the user.
 *
 * WHY a result object (not just the boolean {@link validateSeatCount}): server
 * routes (e.g. `/api/billing/seats`) return a 422 with a human-readable
 * `message` and `minSeats` so the client can render an actionable error. The
 * boolean form remains for client-side render guards (pricing slider) where a
 * yes/no answer is all that's needed.
 */
export type SeatValidationResult = { ok: true } | { ok: false; reason: string; minSeats: number };

/**
 * Validates a seat count for a tier and returns a detailed, user-surfaceable
 * result.
 *
 * - Pro: must be exactly 1 (single-user plan; min == max == 1).
 * - Growth: must be an integer in [{@link GROWTH_BASE_SEATS}, {@link GROWTH_MAX_SEATS}].
 *
 * WHY this replaces the legacy `@styrby/shared/billing` `validateSeatCount`:
 * the legacy validator's `TIER_DEFINITIONS` only knew `team`/`business`/
 * `enterprise` and had NO `growth` key — so calling it with a Growth team's
 * `billing_tier='growth'` dereferenced `undefined.minSeats` → a 500. This
 * canonical version is keyed by the live `'pro' | 'growth'` model.
 *
 * @param tierId - Canonical tier identifier (`'pro'` or `'growth'`).
 * @param seatCount - Proposed seat count.
 * @returns `{ ok: true }` or `{ ok: false, reason, minSeats }`.
 *
 * @example
 * ```ts
 * const v = validateSeatCountResult('growth', 2);
 * if (!v.ok) console.error(v.reason); // "Minimum seat count for growth is 3, got 2."
 * ```
 */
export function validateSeatCountResult(
  tierId: PublicTierId,
  seatCount: number
): SeatValidationResult {
  const tier = CANONICAL_TIER_DEFINITIONS[tierId];

  // Number.isFinite rejects NaN/±Infinity; Number.isInteger additionally
  // rejects fractional seat counts. Both are required to be exhaustive.
  if (!Number.isFinite(seatCount)) {
    return { ok: false, reason: `Seat count must be a finite number, got ${seatCount}.`, minSeats: tier.minSeats };
  }
  if (!Number.isInteger(seatCount)) {
    return { ok: false, reason: `Seat count must be an integer, got ${seatCount}.`, minSeats: tier.minSeats };
  }
  if (seatCount < tier.minSeats) {
    return { ok: false, reason: `Minimum seat count for ${tierId} is ${tier.minSeats}, got ${seatCount}.`, minSeats: tier.minSeats };
  }
  if (seatCount > tier.maxSeats) {
    // Growth self-serve caps at GROWTH_MAX_SEATS; above that routes to sales.
    return { ok: false, reason: `Maximum seat count for ${tierId} is ${tier.maxSeats}, got ${seatCount}. Contact sales for larger teams.`, minSeats: tier.minSeats };
  }

  return { ok: true };
}

/**
 * Input shape for {@link calculateProrationCents}.
 */
export interface ProrationInput {
  /** Seats before the change. Must be a non-negative integer. */
  oldSeats: number;
  /** Seats after the change. Must be a non-negative integer. */
  newSeats: number;
  /** Canonical tier identifier (determines per-seat price; Pro has none). */
  tierId: PublicTierId;
  /** Billing interval — selects the monthly vs. annual per-seat price. */
  cycle: BillingInterval;
  /** Days already elapsed in the current cycle. 0 <= daysElapsed <= daysInCycle. */
  daysElapsed: number;
  /** Total days in the current cycle (≈28-31 monthly, ≈365-366 annual). */
  daysInCycle: number;
}

/**
 * Calculates the prorated charge in integer USD cents for adding Growth seats
 * mid-cycle. Used for the seat-change PREVIEW + the charge we expect Polar to
 * apply when we raise the subscription quantity.
 *
 * Formula: `Δseats × perSeatPriceCents × remainingDays / daysInCycle`, floored.
 *
 * WHY cycle-aware (the legacy module was not): every Growth seat above the
 * included {@link GROWTH_BASE_SEATS} bundle is billed at the add-on price —
 * `$19/mo` ({@link GROWTH_SEAT_MONTHLY_USD_CENTS}) on monthly, `$190/yr`
 * ({@link GROWTH_SEAT_ANNUAL_USD_CENTS}) on annual. The legacy
 * `calculateProrationCents` always used the monthly price, so an annual
 * subscriber's preview was ~12× too low. Selecting the price by `cycle` makes
 * the preview match Polar's actual proration.
 *
 * WHY Math.floor: fractional cents are always truncated in the customer's
 * favour (consistent with {@link calculateAnnualCostCents}).
 *
 * Pro returns 0 (single-seat plan — no seat dimension). Downgrades / no-change
 * return 0 (Polar issues a credit for decreases; this function never charges
 * for a decrease).
 *
 * @param input - {@link ProrationInput}.
 * @returns Prorated charge in integer USD cents (>= 0).
 * @throws {RangeError} When numeric inputs are out of range or non-integer.
 *
 * @example
 * ```ts
 * // Growth monthly 3→5, 15 of 30 days elapsed: 2 × 1900 × 15/30 = 1900 ($19)
 * calculateProrationCents({ oldSeats: 3, newSeats: 5, tierId: 'growth',
 *   cycle: 'monthly', daysElapsed: 15, daysInCycle: 30 }); // 1900
 * // Growth annual 3→4, 73 of 365 days elapsed: 1 × 19000 × 292/365 = 15200 ($152)
 * calculateProrationCents({ oldSeats: 3, newSeats: 4, tierId: 'growth',
 *   cycle: 'annual', daysElapsed: 73, daysInCycle: 365 }); // 15200
 * ```
 */
export function calculateProrationCents({
  oldSeats,
  newSeats,
  tierId,
  cycle,
  daysElapsed,
  daysInCycle,
}: ProrationInput): number {
  // Defensive input validation — comparison guards alone silently pass NaN
  // (every NaN comparison is false), so Number.isFinite + Number.isInteger
  // are both required. Preserves the legacy validator's throw-on-bad-input
  // contract that `/api/billing/seats` relies on.
  if (!Number.isFinite(oldSeats) || !Number.isInteger(oldSeats) || oldSeats < 0) {
    throw new RangeError(`oldSeats must be a non-negative integer, got ${oldSeats}.`);
  }
  if (!Number.isFinite(newSeats) || !Number.isInteger(newSeats) || newSeats < 0) {
    throw new RangeError(`newSeats must be a non-negative integer, got ${newSeats}.`);
  }
  if (!Number.isFinite(daysElapsed) || !Number.isInteger(daysElapsed) || daysElapsed < 0) {
    throw new RangeError(`daysElapsed must be a non-negative integer, got ${daysElapsed}.`);
  }
  if (!Number.isFinite(daysInCycle) || !Number.isInteger(daysInCycle) || daysInCycle <= 0) {
    throw new RangeError(`daysInCycle must be a positive integer, got ${daysInCycle}.`);
  }
  if (daysElapsed > daysInCycle) {
    throw new RangeError(`daysElapsed (${daysElapsed}) cannot exceed daysInCycle (${daysInCycle}).`);
  }

  // Pro is single-seat — there is no seat dimension to prorate.
  if (tierId === 'pro') return 0;

  const deltaSeats = newSeats - oldSeats;
  // Only upgrades (seat increases) generate a proration charge. Decreases are
  // credited by Polar's billing engine, not charged here.
  if (deltaSeats <= 0) return 0;

  const remainingDays = daysInCycle - daysElapsed;
  // End-of-cycle (no remaining days) or start-of-cycle (daysElapsed 0): Polar's
  // next invoice covers the new seats in full — no separate proration charge.
  if (remainingDays === 0 || daysElapsed === 0) return 0;

  const perSeatPriceCents =
    cycle === 'annual' ? GROWTH_SEAT_ANNUAL_USD_CENTS : GROWTH_SEAT_MONTHLY_USD_CENTS;

  return Math.floor((deltaSeats * perSeatPriceCents * remainingDays) / daysInCycle);
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
