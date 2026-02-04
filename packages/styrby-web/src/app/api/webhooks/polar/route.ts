/**
 * Polar Webhook Handler
 *
 * POST /api/webhooks/polar
 *
 * Handles subscription lifecycle events from Polar:
 * - subscription.created
 * - subscription.updated
 * - subscription.canceled
 * - order.created
 *
 * @see https://docs.polar.sh/api-reference/webhooks
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import crypto from 'crypto';

/**
 * Polar webhook event types we handle.
 */
type PolarEvent =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'order.created';

/**
 * Verifies the webhook signature from Polar.
 *
 * @param payload - Raw request body
 * @param signature - Signature from X-Polar-Signature header
 * @param secret - Webhook secret from environment
 * @returns True if signature is valid
 */
function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Maps Polar product IDs to subscription tiers.
 * Handles both monthly and annual product variants.
 */
function getTierFromProductId(productId: string): 'free' | 'pro' | 'power' {
  // Pro tier (monthly or annual)
  if (
    productId === process.env.POLAR_PRO_MONTHLY_PRODUCT_ID ||
    productId === process.env.POLAR_PRO_ANNUAL_PRODUCT_ID
  ) {
    return 'pro';
  }
  // Power tier (monthly or annual)
  if (
    productId === process.env.POLAR_POWER_MONTHLY_PRODUCT_ID ||
    productId === process.env.POLAR_POWER_ANNUAL_PRODUCT_ID
  ) {
    return 'power';
  }
  return 'free';
}

/**
 * Determines billing cycle from product ID.
 */
function getBillingCycleFromProductId(productId: string): 'monthly' | 'annual' {
  if (
    productId === process.env.POLAR_PRO_ANNUAL_PRODUCT_ID ||
    productId === process.env.POLAR_POWER_ANNUAL_PRODUCT_ID
  ) {
    return 'annual';
  }
  return 'monthly';
}

export async function POST(request: Request) {
  const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('POLAR_WEBHOOK_SECRET not configured');
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 500 }
    );
  }

  // Get raw body for signature verification
  const payload = await request.text();

  // Verify signature
  const headersList = await headers();
  const signature = headersList.get('x-polar-signature');

  if (!signature || !verifySignature(payload, signature, webhookSecret)) {
    console.error('Invalid webhook signature');
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 }
    );
  }

  // Parse the event
  let event: {
    type: PolarEvent;
    data: {
      id: string;
      customer_id: string;
      product_id?: string;
      user_id?: string;
      email?: string;
      status?: string;
      current_period_start?: string;
      current_period_end?: string;
      cancel_at_period_end?: boolean;
      canceled_at?: string;
    };
  };

  try {
    event = JSON.parse(payload);
  } catch {
    console.error('Invalid webhook payload');
    return NextResponse.json(
      { error: 'Invalid payload' },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  try {
    switch (event.type) {
      case 'subscription.created':
      case 'subscription.updated': {
        const { data } = event;

        // Find user by email (Polar sends customer email)
        // In production, you'd use Polar customer metadata to link to Supabase user
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', data.user_id || '')
          .single();

        if (!profile) {
          console.log(`No user found for subscription ${data.id}`);
          // Don't fail - Polar might be ahead of user signup
          return NextResponse.json({ received: true });
        }

        // Upsert subscription
        const productId = data.product_id || '';
        await supabase.from('subscriptions').upsert(
          {
            user_id: profile.id,
            polar_subscription_id: data.id,
            polar_customer_id: data.customer_id,
            polar_product_id: productId,
            tier: getTierFromProductId(productId),
            billing_cycle: getBillingCycleFromProductId(productId),
            status: data.status === 'active' ? 'active' : 'canceled',
            current_period_start: data.current_period_start,
            current_period_end: data.current_period_end,
            cancel_at_period_end: data.cancel_at_period_end || false,
          },
          {
            onConflict: 'user_id',
          }
        );

        console.log(`Updated subscription for user ${profile.id}`);
        break;
      }

      case 'subscription.canceled': {
        const { data } = event;

        // Update subscription status
        await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            canceled_at: data.canceled_at || new Date().toISOString(),
          })
          .eq('polar_subscription_id', data.id);

        console.log(`Canceled subscription ${data.id}`);
        break;
      }

      case 'order.created': {
        // Handle one-time purchases if we add them
        console.log(`Order created: ${event.data.id}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 }
    );
  }
}
