/**
 * Polar billing product definitions and pricing math.
 *
 * Single source of truth for all per-seat pricing calculations. Reused by:
 * - /pricing page (public-facing seat-count slider)
 * - /api/billing/checkout (server-side checkout creation)
 * - Future: plan comparison, ROI calculator
 *
 * WHY integer cents everywhere: floating-point arithmetic is unsafe for money.
 * $19.00 × 3 = $56.999... in IEEE 754. Integer cents (1900 × 3 = 5700) are
 * exact and can be formatted to dollars at display time only.
 *
 * WHY basis points for discounts: 1 basis point = 0.01%. Annual discount is
 * expressed as 1700 bps (17%) to avoid 0.17 float multiplication.
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
 */
export const ANNUAL_DISCOUNT_BPS = 1700;

/**
 * Team tier: minimum 3 seats, maximum 100 seats.
 *
 * WHY minimum 3: team plan targets engineering teams. A 1-person "team"
 * should use Solo/Power instead. The 3-seat floor also matches the $57/mo
 * floor pricing in CLAUDE.md.
 */
export const TEAM_MIN_SEATS = 3;
export const TEAM_MAX_SEATS = 100;

/**
 * Business tier: minimum 10 seats, maximum 100 seats.
 *
 * WHY minimum 10: business plan targets larger engineering orgs. The $390/mo
 * floor ($39/seat × 10) is the entry point for business pricing.
 */
export const BUSINESS_MIN_SEATS = 10;
export const BUSINESS_MAX_SEATS = 100;

// ============================================================================
// Tier definitions
// ============================================================================

/**
 * Tier identifiers for the public pricing page.
 * Distinct from internal TierId to avoid coupling to billing internals.
 */
export type PublicTierId = 'solo' | 'team' | 'business' | 'enterprise';

/**
 * Pricing definition for a single tier.
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
   * Per-seat monthly price in USD cents.
   * 0 for enterprise (custom pricing).
   */
  pricePerSeatMonthlyUsdCents: number;
  /** Minimum number of seats. 1 for solo tiers. */
  minSeats: number;
  /** Maximum number of seats. 1 for solo. Infinity for enterprise. */
  maxSeats: number;
  /** Marketing feature bullets. */
  highlights: string[];
  /** CTA button label. */
  cta: string;
  /** Whether to visually highlight this tier as recommended. */
  recommended: boolean;
  /**
   * Checkout entry point URL for this tier.
   * null for enterprise (calendar booking instead).
   */
  checkoutPath: string | null;
}

/**
 * TIER_DEFINITIONS — canonical public-facing pricing tiers.
 *
 * WHY a separate object (not reusing TIERS from polar.ts): TIERS in polar.ts
 * mixes server-side product IDs (env vars) with marketing copy. This module
 * is safe for client-side rendering — no env var reads, no server-only imports.
 *
 * Pricing source: CLAUDE.md "Current Pricing (2026-04-19)"
 * - Solo (Power): $49/mo individual ($41/mo annual)
 * - Team: $19/seat/mo, 3-seat minimum ($57/mo floor)
 * - Business: $39/seat/mo, 10-seat minimum ($390/mo floor)
 * - Enterprise: custom, ~$15K+ annual floor
 */
export const TIER_DEFINITIONS: Record<PublicTierId, TierDefinition> = {
  solo: {
    id: 'solo',
    name: 'Solo',
    tagline: 'For individual developers who ship daily with AI',
    pricePerSeatMonthlyUsdCents: 4900, // $49/mo
    minSeats: 1,
    maxSeats: 1,
    highlights: [
      'All 11 CLI agents (Claude Code, Codex, Gemini CLI + 8 more)',
      'Unlimited sessions',
      '1-year session history',
      'Full cost dashboard + OTEL export',
      'Session checkpoints and sharing',
      'Budget alerts and auto-pause',
      'E2E encryption - zero-knowledge architecture',
      'Push notifications + offline queue',
    ],
    cta: 'Start Free Trial',
    recommended: false,
    checkoutPath: '/signup?plan=power',
  },
  team: {
    id: 'team',
    name: 'Team',
    tagline: 'For engineering teams of 3 to 100 developers',
    pricePerSeatMonthlyUsdCents: 1900, // $19/seat/mo
    minSeats: TEAM_MIN_SEATS,
    maxSeats: TEAM_MAX_SEATS,
    highlights: [
      'Everything in Solo, plus:',
      'Team member management + role-based access',
      'Shared cost dashboards per developer',
      'Approval chains - require team lead sign-off on CLI commands',
      'Full audit trail export (SOC2-ready)',
      'Webhooks + REST API access',
      'Invite flow + seat cap enforcement',
      'Email support',
    ],
    cta: 'Start Team Trial',
    recommended: true,
    checkoutPath: '/signup?plan=team',
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: 'For larger engineering orgs that need custom retention and priority support',
    pricePerSeatMonthlyUsdCents: 3900, // $39/seat/mo
    minSeats: BUSINESS_MIN_SEATS,
    maxSeats: BUSINESS_MAX_SEATS,
    highlights: [
      'Everything in Team, plus:',
      'Custom session retention period',
      'Priority support (4-hour SLA)',
      'Advanced audit log filters and export',
      'Founder-direct onboarding call',
      'Quarterly business reviews',
    ],
    cta: 'Start Business Trial',
    recommended: false,
    checkoutPath: '/signup?plan=business',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: '$15K+ annual floor - custom contract, dedicated support, SSO',
    pricePerSeatMonthlyUsdCents: 0, // Custom
    minSeats: 1,
    maxSeats: Infinity,
    highlights: [
      'Everything in Business, plus:',
      'Enterprise SSO (SAML 2.0 / OIDC)',
      'Custom data residency',
      'Dedicated Slack channel with engineering team',
      'Custom SLA with uptime guarantee',
      'Procurement/legal review support',
      'Volume discounts negotiated directly',
    ],
    cta: 'Talk to Us',
    recommended: false,
    checkoutPath: null, // Calendar booking
  },
};

// ============================================================================
// Pricing math (integer cents + basis points)
// ============================================================================

/**
 * Calculates the total monthly cost in USD cents for a given tier and seat count.
 *
 * WHY: Integer-cents math avoids float drift. 100 seats at $19 = 190000 cents
 * ($1,900) computed as 100 × 1900 = 190000 (exact).
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats. Clamped to tier min/max internally.
 * @returns Total monthly cost in USD cents. 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateMonthlyCostCents('team', 5); // 9500 → $95.00/mo
 * calculateMonthlyCostCents('business', 10); // 39000 → $390.00/mo
 * ```
 */
export function calculateMonthlyCostCents(tierId: PublicTierId, seatCount: number): number {
  const tier = TIER_DEFINITIONS[tierId];
  if (!tier) return 0;
  if (tierId === 'enterprise') return 0;

  // Clamp seat count to tier bounds before computing.
  // WHY: UI slider may pass values outside bounds during animation.
  const seats = Math.max(tier.minSeats, Math.min(tier.maxSeats === Infinity ? seatCount : tier.maxSeats, seatCount));
  return seats * tier.pricePerSeatMonthlyUsdCents;
}

/**
 * Calculates the total annual cost in USD cents for a given tier and seat count,
 * applying the annual discount (1700 basis points = 17%).
 *
 * WHY basis points: avoids the float multiplication hazard of 0.17 × N.
 * The calculation is: annualCents = monthlyTotal × 12 × (10000 - 1700) / 10000
 *                                 = monthlyTotal × 12 × 8300 / 10000
 *
 * Integer division is taken via Math.floor — the subscriber gets the benefit
 * of rounding down (slightly less charged), not the platform.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats.
 * @returns Total annual cost in USD cents (already discounted). 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateAnnualCostCents('team', 3);
 * // monthlyTotal = 3 × 1900 = 5700 cents
 * // annual undiscounted = 5700 × 12 = 68400 cents
 * // discount = 68400 × 1700 / 10000 = 11628 cents
 * // annual discounted = 68400 - 11628 = 56772 cents → $567.72/yr
 * ```
 */
export function calculateAnnualCostCents(tierId: PublicTierId, seatCount: number): number {
  if (tierId === 'enterprise') return 0;
  const monthlyTotal = calculateMonthlyCostCents(tierId, seatCount);
  const annualUndiscounted = monthlyTotal * 12;
  const discountCents = Math.floor((annualUndiscounted * ANNUAL_DISCOUNT_BPS) / 10000);
  return annualUndiscounted - discountCents;
}

/**
 * Calculates the effective per-month cost when paying annually (for display).
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats.
 * @returns Per-month cost in USD cents when billed annually. 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateAnnualMonthlyEquivalentCents('team', 3); // ~4731 → ~$47.31/mo
 * ```
 */
export function calculateAnnualMonthlyEquivalentCents(tierId: PublicTierId, seatCount: number): number {
  const annualCents = calculateAnnualCostCents(tierId, seatCount);
  return Math.floor(annualCents / 12);
}

/**
 * Validates that a seat count is within acceptable bounds for a given tier.
 *
 * Server-side validation mirrors client-side slider. Called by the checkout
 * API to prevent crafted requests with out-of-range seat counts.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Proposed seat count to validate.
 * @returns `true` if the seat count is valid for the tier.
 *
 * @example
 * ```ts
 * validateSeatCount('team', 2); // false (below minimum 3)
 * validateSeatCount('team', 5); // true
 * validateSeatCount('business', 101); // false (above maximum 100)
 * ```
 */
export function validateSeatCount(tierId: PublicTierId, seatCount: number): boolean {
  if (!Number.isInteger(seatCount) || seatCount < 1) return false;
  if (tierId === 'enterprise') return seatCount >= 1;

  const tier = TIER_DEFINITIONS[tierId];
  if (!tier) return false;

  const max = tier.maxSeats === Infinity ? Number.MAX_SAFE_INTEGER : tier.maxSeats;
  return seatCount >= tier.minSeats && seatCount <= max;
}

/**
 * Formats USD cents as a display string.
 *
 * WHY: Centralise formatting so all price displays use the same locale and
 * fractional-digit rules. Amounts under $1 show cents; others show no decimals.
 *
 * @param cents - Amount in USD cents.
 * @returns Formatted string, e.g. "$95", "$1,900", "$0.95".
 *
 * @example
 * ```ts
 * formatCents(9500);   // "$95"
 * formatCents(190000); // "$1,900"
 * formatCents(50);     // "$0.50"
 * ```
 */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (cents === 0) return '$0';
  if (cents % 100 === 0) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(dollars);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}
