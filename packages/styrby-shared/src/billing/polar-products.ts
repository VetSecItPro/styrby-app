/**
 * Polar per-seat billing product definitions and pricing helpers (Phase 2.6).
 *
 * This module is the single source of truth for per-seat pricing math across
 * web, mobile, and the webhook handler. All money values are in integer cents
 * to avoid floating-point rounding errors — IEEE 754 cannot represent $0.01
 * exactly, so even small discrepancies compound over many seats or cycles.
 *
 * WHY env-var driven product IDs (not hardcoded): Polar product IDs are
 * environment-specific (test vs. live mode). Hardcoding live IDs here would
 * create a foot-gun where a developer accidentally charges real customers
 * from a test environment. The env var names are the stable API; the values
 * stay out of the codebase.
 *
 * WHY basis-point discounts (not percentages): Basis points (bps) avoid
 * floating-point representation entirely. 1700 bps = exactly 17%, expressed
 * as integers throughout. The calculation `price × (10000 − bps) / 10000`
 * keeps everything in integer arithmetic with Math.floor to truncate cents.
 *
 * SOC2 CC7.2: Changes to pricing constants are material billing events and
 * must be reflected in audit_log (billing_tier transitions are logged by the
 * Polar webhook handler, Unit B).
 *
 * @module billing/polar-products
 */

// ============================================================================
// Types
// ============================================================================

/**
 * The billable tier names for per-seat plans.
 *
 * WHY 'enterprise' is included but has zero prices: enterprise deals are
 * negotiated custom; we record the tier in the DB and audit log but never
 * run their pricing through this module. Keeping enterprise in the type
 * union avoids a separate code path in callers that iterate tiers.
 */
export type BillableTier = 'team' | 'business' | 'enterprise';

// ============================================================================
// Unit B startup-time env var validation (IMPORTANT — read before modifying)
// ============================================================================
//
// WHY no env var validation here: this module is imported by web, mobile, and
// Edge Functions alike. Throwing at import time based on process.env would
// break mobile and web bundles where Polar product IDs are not relevant.
//
// Unit B (the Polar webhook Edge Function) MUST validate that
//   POLAR_TEAM_MONTHLY_PRODUCT_ID
//   POLAR_TEAM_ANNUAL_PRODUCT_ID
//   POLAR_BUSINESS_MONTHLY_PRODUCT_ID
//   POLAR_BUSINESS_ANNUAL_PRODUCT_ID
// are all present in process.env via a Zod schema guard at cold-start, BEFORE
// accepting any inbound webhook request. Silent undefined at webhook time would
// allow event routing to fall through silently, corrupting subscription state.
// See Phase 2.6 Unit B spec for the required Zod guard pattern.
//
// SOC2 CC7.2: startup validation is a preventive control for billing integrity.

/**
 * Pricing and product metadata for a single billable tier.
 *
 * WHY productIdEnvVar/annualProductIdEnvVar are optional: enterprise tiers use
 * custom bespoke Polar orders created by the sales team on a per-deal basis.
 * There is no single Polar product ID for enterprise. Making these fields
 * optional at the type level (rather than using sentinel empty strings) lets
 * TypeScript enforce that callers guard before reading them, preventing silent
 * undefined dereferences in the webhook handler.
 */
export interface TierDefinition {
  /** Price per seat per month, in integer cents. Enterprise = 0 (custom). */
  seatPriceCents: number;
  /** Minimum seat count required for checkout. Enterprise = 0 (no enforced min). */
  minSeats: number;
  /** Minimum monthly charge in cents = minSeats × seatPriceCents. Enterprise = 0. */
  floorCents: number;
  /**
   * Annual discount expressed in basis points (1 bps = 0.01%).
   * 1700 bps = 17% off. Enterprise = 0 (discount is negotiated separately).
   */
  annualDiscountBps: number;
  /**
   * Name of the environment variable that holds the Polar monthly product ID
   * for this tier. The actual ID is NEVER in code — only the env var name.
   * Undefined for enterprise (no pre-defined Polar product; deals are bespoke).
   */
  productIdEnvVar?: string;
  /**
   * Name of the environment variable that holds the Polar annual product ID.
   * Separate product in Polar for annual billing cycle.
   * Undefined for enterprise (no pre-defined Polar product; deals are bespoke).
   */
  annualProductIdEnvVar?: string;
}

/**
 * Input shape for {@link calculateProrationCents}.
 */
export interface ProrationInput {
  /** Seats count before the upgrade. Must be a non-negative integer. */
  oldSeats: number;
  /** Seats count after the upgrade. Must be a non-negative integer. */
  newSeats: number;
  /** The billing tier (determines per-seat price). */
  tier: BillableTier;
  /**
   * Number of days already elapsed in the current billing cycle.
   * Must satisfy: 0 <= daysElapsed <= daysInCycle.
   */
  daysElapsed: number;
  /**
   * Total days in the current billing cycle (28, 29, 30, or 31 for monthly;
   * 365 or 366 for annual).
   */
  daysInCycle: number;
}

/**
 * Return type for {@link validateSeatCount}.
 */
export type SeatValidationResult =
  | { ok: true }
  | { ok: false; reason: string; minSeats: number };

// ============================================================================
// TIER_DEFINITIONS — single source of truth for pricing
// ============================================================================

/**
 * Readonly map of billable tier names to their pricing metadata.
 *
 * WHY readonly: prevents accidental mutation at runtime, which would silently
 * corrupt every subsequent billing calculation in the same process.
 *
 * Pricing as of 2026-04-23 (CLAUDE.md §Current Pricing):
 *   Team:     $19/seat/mo, 3-seat min ($57/mo floor), 17% annual discount
 *   Business: $39/seat/mo, 10-seat min ($390/mo floor), 17% annual discount
 *   Enterprise: custom (zeros — negotiated out-of-band)
 */
// WHY `as const satisfies Record<BillableTier, TierDefinition>`: the `satisfies`
// operator (TS 4.9+) validates that every key in BillableTier is present at
// compile time — so adding a new BillableTier variant is a compile error until
// TIER_DEFINITIONS is updated. Plain `Readonly<Record<...>>` with `as const`
// does NOT catch missing keys. The `as const` clause preserves literal types
// for downstream inference (e.g. TIER_DEFINITIONS.team.productIdEnvVar is
// `'POLAR_TEAM_MONTHLY_PRODUCT_ID'`, not just `string`).
export const TIER_DEFINITIONS = {
  team: {
    seatPriceCents: 1900,
    minSeats: 3,
    floorCents: 5700, // 3 × 1900
    annualDiscountBps: 1700,
    productIdEnvVar: 'POLAR_TEAM_MONTHLY_PRODUCT_ID',
    annualProductIdEnvVar: 'POLAR_TEAM_ANNUAL_PRODUCT_ID',
  },
  business: {
    seatPriceCents: 3900,
    minSeats: 10,
    floorCents: 39000, // 10 × 3900
    annualDiscountBps: 1700,
    productIdEnvVar: 'POLAR_BUSINESS_MONTHLY_PRODUCT_ID',
    annualProductIdEnvVar: 'POLAR_BUSINESS_ANNUAL_PRODUCT_ID',
  },
  enterprise: {
    // WHY zeros: enterprise pricing is custom and negotiated by sales.
    // These zeros are intentional sentinels — any caller that sees 0 for
    // enterprise must bypass the billing math and route to the sales flow.
    seatPriceCents: 0,
    minSeats: 0,
    floorCents: 0,
    annualDiscountBps: 0,
    // WHY no productIdEnvVar/annualProductIdEnvVar: enterprise deals are
    // bespoke Polar orders created ad-hoc by the sales team. There is no
    // single Polar product UUID for all enterprise accounts. Omitting these
    // fields (instead of using empty strings or sentinels) lets TypeScript
    // enforce that webhook handlers guard `productIdEnvVar !== undefined`
    // before routing, preventing silent undefined dereferences.
  },
} as const satisfies Record<BillableTier, TierDefinition>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the total monthly cost in integer cents for a given tier and
 * seat count.
 *
 * Enterprise always returns 0 — callers must gate on `seatPriceCents === 0`
 * and route enterprise customers to the sales flow.
 *
 * WHY integer math only: Multiplying integer cents by an integer seat count
 * always yields an integer. No rounding needed here.
 *
 * @param tier - The billing tier.
 * @param seats - Number of seats (must be a positive integer; not validated
 *   here — call {@link validateSeatCount} first).
 * @returns Monthly cost in integer cents.
 *
 * @example
 * ```ts
 * calculateMonthlyCostCents('team', 5); // 9500
 * ```
 */
export function calculateMonthlyCostCents(tier: BillableTier, seats: number): number {
  const def = TIER_DEFINITIONS[tier];
  // WHY early return for enterprise: seatPriceCents is 0 and minSeats is 0,
  // so the math would yield 0 anyway — but being explicit avoids confusion.
  if (def.seatPriceCents === 0) return 0;
  return def.seatPriceCents * seats;
}

/**
 * Returns the total annual cost in integer cents for a given tier and
 * seat count, with the annual discount applied.
 *
 * Formula: Math.floor(monthlyCents × 12 × (10000 − annualDiscountBps) / 10000)
 *
 * WHY Math.floor: we always truncate fractional cents in the customer's
 * favour (never charge a partial cent). Using floor consistently also makes
 * test assertions predictable.
 *
 * WHY multiply before dividing: integer arithmetic; if we divided first we
 * could lose precision before the final result.
 *
 * @param tier - The billing tier.
 * @param seats - Number of seats.
 * @returns Annual cost in integer cents (discount applied, floored).
 *
 * @example
 * ```ts
 * // team × 3: 5700 × 12 × (10000 − 1700) / 10000 = 56772
 * calculateAnnualCostCents('team', 3); // 56772
 * ```
 */
export function calculateAnnualCostCents(tier: BillableTier, seats: number): number {
  const monthly = calculateMonthlyCostCents(tier, seats);
  if (monthly === 0) return 0;

  const def = TIER_DEFINITIONS[tier];
  // Math.floor keeps us in integer cents; customer always pays the lower value
  // when the discount does not produce a whole number of cents.
  return Math.floor((monthly * 12 * (10000 - def.annualDiscountBps)) / 10000);
}

/**
 * Validates that `seats` is a valid seat count for the given tier.
 *
 * Checks:
 *  1. Must be a finite, non-NaN number.
 *  2. Must be a non-negative integer (no fractions).
 *  3. Must be >= tier's `minSeats` (enterprise has no minimum → always passes
 *     integer check).
 *
 * WHY separate validation helper: keeps calculateMonthlyCostCents pure (no
 * throwing) and gives callers a typed result they can pattern-match without
 * wrapping in try/catch.
 *
 * @param tier - The billing tier.
 * @param seats - The proposed seat count.
 * @returns `{ok: true}` or `{ok: false, reason, minSeats}`.
 *
 * @example
 * ```ts
 * const v = validateSeatCount('team', 2);
 * if (!v.ok) console.error(v.reason); // "Minimum seat count for team is 3"
 * ```
 */
export function validateSeatCount(tier: BillableTier, seats: number): SeatValidationResult {
  const def = TIER_DEFINITIONS[tier];

  // Guard: must be a finite number (catches NaN, Infinity, -Infinity).
  if (!Number.isFinite(seats)) {
    return {
      ok: false,
      reason: `Seat count must be a finite number, got ${seats}.`,
      minSeats: def.minSeats,
    };
  }

  // Guard: must be a non-negative integer.
  if (!Number.isInteger(seats)) {
    return {
      ok: false,
      reason: `Seat count must be an integer, got ${seats}.`,
      minSeats: def.minSeats,
    };
  }

  if (seats < 0) {
    return {
      ok: false,
      reason: `Seat count must be non-negative, got ${seats}.`,
      minSeats: def.minSeats,
    };
  }

  // WHY enterprise skips minimum: seat count for enterprise is determined
  // by the sales contract; no code-side minimum to enforce.
  if (tier !== 'enterprise' && seats < def.minSeats) {
    return {
      ok: false,
      reason: `Minimum seat count for ${tier} is ${def.minSeats}, got ${seats}.`,
      minSeats: def.minSeats,
    };
  }

  return { ok: true };
}

/**
 * Calculates the prorated charge in integer cents for adding seats mid-cycle.
 *
 * This is used exclusively for UPGRADES (adding seats). Downgrades generate a
 * Polar credit, not a charge — that flow is handled entirely by Polar's billing
 * engine and Unit B's webhook handler; this function must never be called for
 * seat decreases.
 *
 * Proration formula:
 *   deltaSeats × seatPriceCents × (daysInCycle − daysElapsed) / daysInCycle
 *
 * WHY remaining days (not elapsed days): the charge covers the portion of the
 * cycle that has NOT yet passed. If 15 of 30 days have elapsed, the new seats
 * are charged for the remaining 15 days (50% of the monthly price).
 *
 * WHY Math.floor: consistent with {@link calculateAnnualCostCents} — fractional
 * cents are always truncated in the customer's favour.
 *
 * WHY integer-only inputs for seat counts: fractional seats are nonsensical
 * and would silently produce incorrect proration if allowed.
 *
 * @param input - {@link ProrationInput} with old/new seats, tier, and cycle info.
 * @returns Prorated charge in integer cents.
 * @throws {RangeError} When inputs are out of range or non-integer.
 *
 * @example
 * ```ts
 * // team 3→5, 15 days elapsed of 30: 2 × 1900 × 15/30 = 1900 cents
 * calculateProrationCents({ oldSeats: 3, newSeats: 5, tier: 'team',
 *   daysElapsed: 15, daysInCycle: 30 }); // 1900
 * ```
 */
export function calculateProrationCents({
  oldSeats,
  newSeats,
  tier,
  daysElapsed,
  daysInCycle,
}: ProrationInput): number {
  // WHY Number.isFinite + Number.isInteger together: comparison-based guards
  // (e.g. `x < 0`) silently pass NaN due to IEEE-754 semantics — NaN
  // comparisons always return false, so `-1 < NaN` is false (guard passes)
  // and `NaN > 30` is false (guard passes). Using Number.isFinite rejects NaN
  // and ±Infinity in one check; Number.isInteger additionally rejects
  // fractional values. Both checks are required together to be exhaustive.

  // Validate seat inputs: must be non-negative finite integers.
  if (!Number.isFinite(oldSeats) || !Number.isInteger(oldSeats)) {
    throw new RangeError(`oldSeats must be a non-negative integer, got ${oldSeats}.`);
  }
  if (oldSeats < 0) {
    throw new RangeError(`oldSeats must be non-negative, got ${oldSeats}.`);
  }
  if (!Number.isFinite(newSeats) || !Number.isInteger(newSeats)) {
    throw new RangeError(`newSeats must be a non-negative integer, got ${newSeats}.`);
  }
  if (newSeats < 0) {
    throw new RangeError(`newSeats must be non-negative, got ${newSeats}.`);
  }

  // Validate cycle inputs: daysElapsed must be a non-negative integer;
  // daysInCycle must be a positive integer; daysElapsed must not exceed
  // daysInCycle.
  if (!Number.isFinite(daysElapsed) || !Number.isInteger(daysElapsed) || daysElapsed < 0) {
    throw new RangeError(`daysElapsed must be a non-negative integer, got ${daysElapsed}.`);
  }
  if (!Number.isFinite(daysInCycle) || !Number.isInteger(daysInCycle) || daysInCycle <= 0) {
    throw new RangeError(`daysInCycle must be a positive integer, got ${daysInCycle}.`);
  }
  if (daysElapsed > daysInCycle) {
    throw new RangeError(
      `daysElapsed (${daysElapsed}) cannot exceed daysInCycle (${daysInCycle}).`,
    );
  }

  const def = TIER_DEFINITIONS[tier];

  // WHY enterprise returns 0: seatPriceCents is 0 (custom deal); no formula
  // can produce a meaningful proration for a custom price.
  if (def.seatPriceCents === 0) return 0;

  const deltaSeats = newSeats - oldSeats;

  // No seat change → no charge.
  if (deltaSeats === 0) return 0;

  const remainingDays = daysInCycle - daysElapsed;

  // If we're at the end of the cycle (daysElapsed === daysInCycle), the next
  // cycle's invoice will cover the new seats in full — no proration charge.
  if (remainingDays === 0) return 0;

  // WHY daysElapsed === 0 returns 0: at the very start of a cycle, Polar will
  // issue a full charge for all seats on the next invoice; we do not issue a
  // separate proration charge for a cycle that hasn't started yet.
  if (daysElapsed === 0) return 0;

  // Core proration formula — integer arithmetic throughout.
  // deltaSeats × price × remaining / total, floored to avoid fractional cents.
  return Math.floor((deltaSeats * def.seatPriceCents * remainingDays) / daysInCycle);
}
