/**
 * Checkout API Route
 *
 * POST /api/billing/checkout
 *
 * Creates a Polar checkout session for a Pro or Growth subscription.
 *
 * **Growth model (sandbox-validated 2026-05-04):** Growth is a SINGLE
 * Polar product (`Styrby Growth Monthly` / `Styrby Growth Annual`)
 * configured with TIERED seat-based pricing — first 3 seats at $33 each
 * (= $99 base), seats 4+ at $19 each. The full $99-base + $19/seat-after-3
 * model is encoded in the BASE product alone. There are NO separate seat-
 * addon products in the checkout call; "Styrby Growth Seat" products in
 * the Polar dashboard are vestigial and ignored here.
 *
 * **Wire format:**
 *   `{ products: [growthBaseId], seats: totalSeats, minSeats: 3, maxSeats: 25, ... }`
 *
 * Polar will lock the hosted-checkout seat selector to `[minSeats, maxSeats]`
 * (defense-in-depth — server-side `validateSeatCount` is the primary gate).
 *
 * @auth Required - Supabase Auth JWT
 * @rateLimit 5 requests per minute (RATE_LIMITS.checkout)
 *
 * @body {
 *   tierId: 'pro' | 'growth',
 *   billingCycle?: 'monthly' | 'annual',  // defaults 'monthly'
 *   seats?: number  // required for growth, ignored for pro
 * }
 *
 * @returns 200 { url: string }
 *
 * @error 400 { error: string }
 * @error 401 { error: 'Unauthorized' }
 * @error 422 { error: 'INVALID_SEATS', message, minSeats, maxSeats }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to create checkout session' }
 *
 * Security:
 *   - tierId enforced via z.enum allowlist (no string passthrough).
 *   - seats re-validated server-side regardless of slider state.
 *   - Polar hosted checkout locked to min/max seats (cannot be raised by
 *     the user changing the seat selector on the hosted page).
 *   - POLAR_ACCESS_TOKEN never logged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type BillingCycle } from '@/lib/polar';
import {
  GROWTH_BASE_SEATS,
  GROWTH_MAX_SEATS,
  validateSeatCount as validatePublicSeatCount,
} from '@/lib/billing/polar-products';
import { Polar } from '@polar-sh/sdk';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Zod schema for checkout request validation. Discriminated union so the
 * shape per tier is enforced at the schema layer.
 *
 * WHY discriminated union (P1-BILLING-7):
 *   - Pro is a single-seat plan; sending `seats` for Pro is a client bug
 *     and should produce a loud 400, not silent acceptance with the field
 *     ignored. The Pro variant has NO `seats` field at all.
 *   - Growth requires `seats` (and we still re-validate the value against
 *     bounds in code, since Zod can't express `3 ≤ seats ≤ 25` cleanly
 *     here without dragging in the runtime constants — and the route
 *     produces a structured INVALID_SEATS 422 with min/max in the body).
 *
 * WHY z.enum on tierId (the discriminator): the public pricing surface
 * ships exactly Pro + Growth. A bare z.string() lets arbitrary input
 * reach the TIERS lookup; the enum rejects unknown tiers before any
 * business logic runs.
 */
const CheckoutRequestSchema = z.discriminatedUnion('tierId', [
  // .strict() rejects extra keys like `seats` so Pro callers cannot
  // silently send a seat count (P1-BILLING-7).
  z
    .object({
      tierId: z.literal('pro'),
      billingCycle: z.enum(['monthly', 'annual']).optional().default('monthly'),
    })
    .strict(),
  z
    .object({
      tierId: z.literal('growth'),
      billingCycle: z.enum(['monthly', 'annual']).optional().default('monthly'),
      seats: z
        .number({ invalid_type_error: 'seats must be a number' })
        .int('seats must be an integer')
        .positive('seats must be positive')
        .optional(),
    })
    .strict(),
]);

/**
 * POLAR_ACCESS_TOKEN — Server-side API key that authenticates requests to Polar.
 *
 * Source: Polar Dashboard > Settings > API Keys
 * Format: "polar_at_<alphanumeric>" — server-only, never expose in the browser.
 * Rotation: annually or immediately upon suspected compromise.
 */
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

export async function POST(request: NextRequest) {
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.checkout, 'checkout');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const parseResult = CheckoutRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Discriminated union: `seats` only exists on the Growth variant.
    const parsed = parseResult.data;
    const tierId = parsed.tierId;
    const billingCycle = parsed.billingCycle as BillingCycle;
    const seats = parsed.tierId === 'growth' ? parsed.seats : undefined;

    // ── Pro: single product, no seats ──────────────────────────────────────
    if (tierId === 'pro') {
      const productId = TIERS.pro.polarProductId[billingCycle];
      if (!productId) {
        return NextResponse.json({ error: 'Tier not available for purchase' }, { status: 400 });
      }

      const checkout = await polar.checkouts.create({
        products: [productId],
        successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
        customerEmail: user.email!,
        metadata: {
          userId: user.id,
          tierId,
          billingCycle,
        },
      });

      return NextResponse.json({ url: checkout.url });
    }

    // ── Growth: single seat-based product (tiered pricing baked in) ────────
    // Sandbox-validated 2026-05-04 across seats={3,4,5,10,15,20,25} for
    // both monthly and annual cycles — every checkout's total_amount
    // matched calculateMonthlyCostCents/calculateAnnualCostCents to the
    // cent (14/14 perfect matches).
    //
    //   sandbox: products=[gb], seats=3  → total_amount=$99    (= $99 base)
    //   sandbox: products=[gb], seats=5  → total_amount=$137   (= $99 + 2×$19)
    //   sandbox: products=[gb], seats=22 → total_amount=$460   (= $99 + 19×$19)
    //   sandbox: products=[gb], seats=25 → total_amount=$517   (= $99 + 22×$19)
    const requestedSeats = seats ?? GROWTH_BASE_SEATS;

    // Re-validate seats against tier bounds. NEVER trust client state.
    if (!validatePublicSeatCount('growth', requestedSeats)) {
      return NextResponse.json(
        {
          error: 'INVALID_SEATS',
          message: `Growth seats must be between ${GROWTH_BASE_SEATS} and ${GROWTH_MAX_SEATS}`,
          minSeats: GROWTH_BASE_SEATS,
          maxSeats: GROWTH_MAX_SEATS,
        },
        { status: 422 }
      );
    }

    const baseProductId = TIERS.growth.polarProductId[billingCycle];
    if (!baseProductId) {
      return NextResponse.json({ error: 'Tier not available for purchase' }, { status: 400 });
    }

    // WHY minSeats / maxSeats on the checkout (defense-in-depth, P1-BILLING-5):
    // Polar's hosted checkout page may render a seat selector on seat-based
    // products that lets the customer change the count after our route built
    // the checkout. Without bounds, a user could pay $33 for 1 seat or $1942
    // for 100 seats — neither matches what we sell. Passing minSeats/maxSeats
    // locks the selector to the same range our server-side validateSeatCount
    // enforces. Sandbox-confirmed Polar accepts these fields and reflects them
    // back in the checkout response.
    const checkout = await polar.checkouts.create({
      products: [baseProductId],
      seats: requestedSeats,
      minSeats: GROWTH_BASE_SEATS,
      maxSeats: GROWTH_MAX_SEATS,
      successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
      customerEmail: user.email!,
      metadata: {
        userId: user.id,
        tierId,
        billingCycle,
        seats: requestedSeats,
      },
    });

    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Checkout error:', isDev ? error : message);

    // WHY a 502 path on the seat-based config mismatch (P0-PROD-POLAR-2):
    // If the production Polar product is mistakenly configured as fixed-
    // price instead of seat-based, the SDK throws with the literal Polar
    // error "Seats can only be set for seat-based pricing." Returning the
    // generic 500 makes this look like a Styrby outage. Returning a 502
    // with a clear hint tells ops it's an upstream config issue and tells
    // the customer the right thing ("billing config issue, contact support")
    // without leaking the Polar internals.
    if (typeof message === 'string' && /seat-based pricing/i.test(message)) {
      return NextResponse.json(
        {
          error: 'BILLING_CONFIG_ERROR',
          message: 'Subscription billing is temporarily unavailable. Please contact support@styrbyapp.com.',
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}
