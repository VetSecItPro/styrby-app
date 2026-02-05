/**
 * Checkout API Route
 *
 * POST /api/billing/checkout
 *
 * Creates a Polar checkout session for subscription upgrade.
 *
 * @auth Required - Supabase Auth JWT
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
 * @error 500 { error: 'Failed to create checkout session' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId, type BillingCycle } from '@/lib/polar';
import { Polar } from '@polar-sh/sdk';
import { z } from 'zod';

/**
 * Zod schema for checkout request validation.
 * WHY: Prevents malformed or unexpected input from reaching the Polar API.
 */
const CheckoutRequestSchema = z.object({
  tierId: z.string().min(1, 'tierId is required'),
  billingCycle: z.enum(['monthly', 'annual']).optional().default('monthly'),
});

const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

export async function POST(request: NextRequest) {
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

    // Create checkout session
    const checkout = await polar.checkouts.create({
      productId,
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
