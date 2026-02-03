/**
 * Checkout API Route
 *
 * Creates a Polar checkout session for subscription upgrade.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { Polar } from '@polar-sh/sdk';

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

    // Parse request body
    const { tierId } = (await request.json()) as { tierId: TierId };

    if (!tierId || !TIERS[tierId]) {
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
    }

    const tier = TIERS[tierId];

    if (!tier.polarProductId) {
      return NextResponse.json({ error: 'Tier not available for purchase' }, { status: 400 });
    }

    // Create checkout session
    const checkout = await polar.checkouts.create({
      productId: tier.polarProductId,
      successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
      customerEmail: user.email!,
      metadata: {
        userId: user.id,
        tierId,
      },
    });

    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}
