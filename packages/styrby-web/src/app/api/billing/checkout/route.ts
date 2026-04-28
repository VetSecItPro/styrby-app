/**
 * Checkout API Route
 *
 * POST /api/billing/checkout
 *
 * Creates a Polar checkout session for subscription upgrade.
 *
 * @auth Required - Supabase Auth JWT
 * @rateLimit 5 requests per minute
 *
 * @body {
 *   tierId: 'pro' | 'power',
 *   billingCycle?: 'monthly' | 'annual'
 * }
 *
 * @returns 200 { url: string }
 *
 * @error 400 { error: string }
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to create checkout session' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId, type BillingCycle } from '@/lib/polar';
import { Polar } from '@polar-sh/sdk';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Zod schema for checkout request validation.
 * WHY: Prevents malformed or unexpected input from reaching the Polar API.
 *
 * SEC-LOGIC-005 FIX: tierId is now z.enum(['pro', 'power']) instead of
 * z.string(). WHY: A plain z.string() allows any value to pass validation,
 * meaning an attacker could send tierId='free' or tierId='../admin' and reach
 * the TIERS[tierId] lookup with arbitrary input. z.enum enforces an allowlist
 * at the schema layer, before any business logic runs, and produces a clear
 * validation error for unexpected values rather than silently failing at the
 * TIERS lookup.
 */
const CheckoutRequestSchema = z.object({
  tierId: z.enum(['pro', 'power'], {
    errorMap: () => ({ message: "tierId must be 'pro' or 'power'" }),
  }),
  billingCycle: z.enum(['monthly', 'annual']).optional().default('monthly'),
});

/**
 * POLAR_ACCESS_TOKEN — Server-side API key that authenticates requests to Polar.
 *
 * Source: Polar Dashboard (polar.sh) > Settings > API Keys > Create Token
 * Format: "polar_at_<alphanumeric, ~48 chars>" — server-only, never expose in the browser
 * Required in: all (local / preview / production)
 * Behavior when missing: Polar SDK initializes with `undefined`; the first
 *   checkout request will throw a 401 from Polar, returning 500 to the client.
 * Rotation: annually or immediately upon suspected compromise.
 */
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

export async function POST(request: NextRequest) {
  // Rate limit check - 5 checkout attempts per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.checkout, 'checkout');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body with Zod
    const rawBody = await request.json();
    const parseResult = CheckoutRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // tierId is 'pro' | 'power' (enforced by z.enum above), safe to cast to TierId
    const { tierId, billingCycle } = parseResult.data as {
      tierId: TierId;
      billingCycle: BillingCycle;
    };

    if (!TIERS[tierId]) {
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
    }

    const tier = TIERS[tierId];
    const productId = tier.polarProductId[billingCycle];

    if (!productId) {
      return NextResponse.json({ error: 'Tier not available for purchase' }, { status: 400 });
    }

    // Create checkout session.
    // WHY products array: SDK 0.30+ renamed `productId` (string) to
    // `products` (string[]). The wire API has always expected an array.
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
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Checkout error:', isDev ? error : (error instanceof Error ? error.message : 'Unknown error'));
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}
