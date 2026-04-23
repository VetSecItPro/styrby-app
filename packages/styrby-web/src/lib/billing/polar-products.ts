/**
 * Polar billing product definitions and pricing helpers for the public pricing page.
 *
 * This module EXTENDS @styrby/shared/billing — it delegates all core per-seat
 * math (team, business, enterprise) to the shared module and adds only what is
 * pricing-page-specific:
 *   - PublicTierId including 'solo' (no Polar billing object; free/Power tier)
 *   - Slider bound constants (TEAM_MIN_SEATS, TEAM_MAX_SEATS, etc.)
 *   - ANNUAL_DISCOUNT_BPS constant (re-exported for display code)
 *   - TIER_DEFINITIONS with solo entry and UI metadata (name, tagline, CTA, etc.)
 *   - calculateAnnualMonthlyEquivalentCents — display helper (annual ÷ 12)
 *   - formatCents — display helper (cents → "$X.XX")
 *
 * WHY delegate to shared for team/business math:
 *   SOC2 CC7.2 — billing math must have a single code path. Two independent
 *   implementations of the same formula create audit risk: a price bump would
 *   require two coordinated edits, and divergence would silently corrupt one
 *   surface (pricing page display vs. checkout API) without a type error.
 *
 * WHY solo handled locally:
 *   Solo is a fixed-price individual plan with no Polar per-seat billing object.
 *   @styrby/shared/billing's BillableTier union only covers 'team' | 'business' |
 *   'enterprise'. Solo lives here where the PublicTierId type is defined.
 *
 * @module billing/polar-products
 */

import {
  calculateMonthlyCostCents as sharedCalculateMonthlyCostCents,
  calculateAnnualCostCents as sharedCalculateAnnualCostCents,
  validateSeatCount as sharedValidateSeatCount,
  type BillableTier,
} from '@styrby/shared/billing';

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
 * WHY re-exported here (not just from shared): pricing page components import
 * from this module; having them reach into @styrby/shared/billing directly
 * would bypass the PublicTierId layer that this module owns.
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
 *
 * WHY 'solo' exists here but not in shared BillableTier: solo is the
 * free/Power individual plan. It has no Polar per-seat product object and
 * is not billed through the same metered mechanism as team/business. The
 * shared module's BillableTier only covers plans that go through Polar
 * per-seat checkout. Solo lives in PublicTierId because the pricing page
 * must render all four tiers side-by-side.
 */
export type PublicTierId = 'solo' | 'team' | 'business' | 'enterprise';

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
 * WHY a separate object (not reusing TIER_DEFINITIONS from @styrby/shared):
 *   The shared TIER_DEFINITIONS carries server-side metadata (productIdEnvVar,
 *   annualProductIdEnvVar) and only covers BillableTier (team/business/enterprise).
 *   This object is safe for client-side rendering — no env var reads, no
 *   server-only imports — and includes the solo tier used only on this page.
 *
 * Pricing source: CLAUDE.md "Current Pricing (2026-04-19)"
 *   - Solo (Power): $49/mo individual ($41/mo annual)
 *   - Team: $19/seat/mo, 3-seat minimum ($57/mo floor)
 *   - Business: $39/seat/mo, 10-seat minimum ($390/mo floor)
 *   - Enterprise: custom, ~$15K+ annual floor
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
// Pricing math — delegates to @styrby/shared/billing for team/business
// ============================================================================

/**
 * Calculates the total monthly cost in USD cents for a given tier and seat count.
 *
 * Delegation:
 *   - 'team' | 'business' | 'enterprise' → sharedCalculateMonthlyCostCents
 *     (single source of truth in @styrby/shared/billing; SOC2 CC7.2)
 *   - 'solo' → handled locally (solo is not a BillableTier; no Polar per-seat
 *     billing object; price is a fixed $49/mo regardless of "seat count")
 *
 * WHY clamping for solo: the pricing page slider doesn't exist for solo (maxSeats=1),
 * but clamping guards against programmatic callers passing unexpected values.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats. Clamped to tier min/max for solo.
 * @returns Total monthly cost in USD cents. 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateMonthlyCostCents('solo', 1);     // 4900  → $49.00/mo
 * calculateMonthlyCostCents('team', 5);     // 9500  → $95.00/mo
 * calculateMonthlyCostCents('business', 10); // 39000 → $390.00/mo
 * calculateMonthlyCostCents('enterprise', 50); // 0   → custom
 * ```
 */
export function calculateMonthlyCostCents(tierId: PublicTierId, seatCount: number): number {
  if (tierId === 'solo') {
    // WHY: solo has exactly 1 seat — fixed price; clamp before multiplying.
    const tier = TIER_DEFINITIONS.solo;
    const seats = Math.max(tier.minSeats, Math.min(tier.maxSeats, seatCount));
    return seats * tier.pricePerSeatMonthlyUsdCents;
  }

  // Delegate team / business / enterprise to the shared canonical implementation.
  // BillableTier = 'team' | 'business' | 'enterprise' — all non-solo PublicTierIds.
  return sharedCalculateMonthlyCostCents(tierId as BillableTier, seatCount);
}

/**
 * Calculates the total annual cost in USD cents for a given tier and seat count,
 * applying the 17% annual discount (1700 basis points).
 *
 * Delegation:
 *   - 'team' | 'business' | 'enterprise' → sharedCalculateAnnualCostCents
 *   - 'solo' → computed locally using ANNUAL_DISCOUNT_BPS (solo is not in
 *     shared BillableTier, but the same discount formula applies)
 *
 * WHY the solo formula matches shared's formula exactly: consistency — both use
 * Math.floor((monthly × 12 × (10000 - bps)) / 10000) to keep discount math
 * in integer cents and truncate in the customer's favour.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats.
 * @returns Total annual cost in USD cents (already discounted). 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateAnnualCostCents('solo', 1);
 * // monthly = 4900, undiscounted annual = 58800
 * // discount = floor(58800 × 1700 / 10000) = 9996
 * // annual = 48804
 * ```
 */
export function calculateAnnualCostCents(tierId: PublicTierId, seatCount: number): number {
  if (tierId === 'solo') {
    const monthly = calculateMonthlyCostCents('solo', seatCount);
    const annualUndiscounted = monthly * 12;
    const discountCents = Math.floor((annualUndiscounted * ANNUAL_DISCOUNT_BPS) / 10000);
    return annualUndiscounted - discountCents;
  }

  // Delegate team / business / enterprise to shared.
  return sharedCalculateAnnualCostCents(tierId as BillableTier, seatCount);
}

/**
 * Calculates the effective per-month cost when paying annually (for display).
 *
 * Used by the pricing page toggle to show "billed annually at $X/mo".
 * Not in shared because it is a display helper — shared only exposes billing math.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Number of seats.
 * @returns Per-month cost in USD cents when billed annually. 0 for enterprise.
 *
 * @example
 * ```ts
 * calculateAnnualMonthlyEquivalentCents('team', 3); // floor(56772 / 12) = 4731
 * ```
 */
export function calculateAnnualMonthlyEquivalentCents(tierId: PublicTierId, seatCount: number): number {
  const annualCents = calculateAnnualCostCents(tierId, seatCount);
  return Math.floor(annualCents / 12);
}

/**
 * Validates that a seat count is within acceptable bounds for a given tier.
 *
 * Delegation:
 *   - 'team' | 'business' | 'enterprise' → sharedValidateSeatCount (returns
 *     SeatValidationResult), mapped to boolean (.ok) for API parity.
 *   - 'solo' → handled locally (min 1, max 1).
 *
 * WHY boolean return (not SeatValidationResult): callers on the pricing page
 * (checkout page, billing API) expect a boolean. The shared function returns a
 * richer SeatValidationResult for webhook handlers that need the failure reason —
 * those callers import directly from @styrby/shared/billing.
 *
 * @param tierId - The tier identifier.
 * @param seatCount - Proposed seat count to validate.
 * @returns `true` if the seat count is valid for the tier.
 *
 * @example
 * ```ts
 * validateSeatCount('solo', 1);    // true
 * validateSeatCount('team', 2);    // false (below minimum 3)
 * validateSeatCount('team', 5);    // true
 * validateSeatCount('business', 101); // false (above maximum 100)
 * ```
 */
export function validateSeatCount(tierId: PublicTierId, seatCount: number): boolean {
  if (tierId === 'solo') {
    return Number.isInteger(seatCount) && seatCount === 1;
  }

  if (tierId === 'enterprise') {
    // WHY not delegating enterprise to shared: shared validates enterprise as
    // "any non-negative integer" (0 is technically allowed there because the
    // sales contract determines the actual seat count). The pricing page slider
    // requires at least 1 seat for any tier — 0 is never a valid UI input.
    return Number.isInteger(seatCount) && seatCount >= 1;
  }

  // Delegate minimum-seat enforcement to shared for team / business.
  // sharedValidateSeatCount returns SeatValidationResult; extract .ok.
  const sharedResult = sharedValidateSeatCount(tierId as BillableTier, seatCount);
  if (!sharedResult.ok) return false;

  // WHY enforce max here (not in shared): shared billing math has no concept of
  // a UI slider maximum. The 100-seat cap is a pricing-page rule — seats beyond
  // 100 are handled by the enterprise tier via the sales team, not a self-serve
  // slider. Shared intentionally omits maxSeats so that webhook handlers (which
  // receive Polar-approved seat counts) are not artificially capped.
  const tier = TIER_DEFINITIONS[tierId];
  if (tier.maxSeats !== Infinity && seatCount > tier.maxSeats) return false;

  return true;
}

/**
 * Formats USD cents as a display string.
 *
 * WHY not in shared: formatting is a display concern tied to the web locale.
 * Shared billing math is locale-agnostic (integer cents only). Mobile has its
 * own formatting layer via platform-billing.ts.
 *
 * @param cents - Amount in USD cents.
 * @returns Formatted string, e.g. "$95", "$1,900", "$0.50".
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
