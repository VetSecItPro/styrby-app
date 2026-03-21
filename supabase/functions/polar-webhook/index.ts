/**
 * Polar Webhook Handler - Supabase Edge Function
 *
 * Handles subscription lifecycle events from Polar:
 * - subscription.created
 * - subscription.updated
 * - subscription.canceled
 * - order.created
 *
 * Syncs subscription status to the database.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

// ============================================================================
// Types
// ============================================================================

interface PolarSubscription {
  id: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  started_at: string;
  ended_at: string | null;
  customer_id: string;
  product_id: string;
  price_id: string;
  metadata: Record<string, string>;
}

interface PolarOrder {
  id: string;
  customer_id: string;
  product_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

interface PolarCustomer {
  id: string;
  email: string;
  name: string | null;
  metadata: Record<string, string>;
}

interface WebhookPayload {
  type: string;
  data: {
    subscription?: PolarSubscription;
    order?: PolarOrder;
    customer?: PolarCustomer;
  };
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify Polar webhook signature using HMAC SHA-256
 */
async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================================
// Subscription Tier Mapping
// ============================================================================

/**
 * Map Polar product ID to subscription tier
 */
function getTierFromProductId(productId: string): 'free' | 'pro' | 'power' | 'team' {
  const proProductId = Deno.env.get('POLAR_PRO_PRODUCT_ID');
  const powerProductId = Deno.env.get('POLAR_POWER_PRODUCT_ID');

  if (productId === proProductId) return 'pro';
  if (productId === powerProductId) return 'power';

  // Default to free for unknown products
  return 'free';
}

/**
 * Map Polar status to our subscription status
 */
function mapStatus(
  polarStatus: PolarSubscription['status']
): 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' {
  switch (polarStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
    default:
      return 'incomplete';
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle subscription.created event
 */
async function handleSubscriptionCreated(
  supabase: ReturnType<typeof createClient>,
  subscription: PolarSubscription,
  customer: PolarCustomer | undefined
) {
  // Find user by email from customer metadata or customer object
  const email = customer?.email || subscription.metadata?.user_email;
  if (!email) {
    console.error('No email found for subscription:', subscription.id);
    return;
  }

  // WHY: Email is on auth.users, not profiles. Edge Functions have service
  // role access and can query auth.users via the admin API.
  const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
  const matchedUser = authData?.users?.find((u) => u.email === email);

  if (!matchedUser) {
    console.error('No user found for email:', email);
    return;
  }

  const profile = { id: matchedUser.id };

  const tier = getTierFromProductId(subscription.product_id);

  // Upsert subscription
  const { error } = await supabase.from('subscriptions').upsert(
    {
      user_id: profile.id,
      polar_subscription_id: subscription.id,
      polar_customer_id: subscription.customer_id,
      tier,
      status: mapStatus(subscription.status),
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
    {
      onConflict: 'polar_subscription_id',
    }
  );

  if (error) {
    console.error('Error upserting subscription:', error);
    throw error;
  }

  // WHY: Tier is stored on the subscriptions table (upserted above), not profiles.
  // The profiles table has no `tier` column.

  console.log('Subscription created:', subscription.id, 'tier:', tier);
}

/**
 * Handle subscription.updated event
 */
async function handleSubscriptionUpdated(
  supabase: ReturnType<typeof createClient>,
  subscription: PolarSubscription
) {
  const tier = getTierFromProductId(subscription.product_id);

  // Update subscription
  const { data, error } = await supabase
    .from('subscriptions')
    .update({
      tier,
      status: mapStatus(subscription.status),
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
    })
    .eq('polar_subscription_id', subscription.id)
    .select('user_id')
    .single();

  if (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }

  // Update user's tier in profile
  // WHY: Tier is on subscriptions table (updated above), not profiles.

  console.log('Subscription updated:', subscription.id, 'status:', subscription.status);
}

/**
 * Handle subscription.canceled event
 */
async function handleSubscriptionCanceled(
  supabase: ReturnType<typeof createClient>,
  subscription: PolarSubscription
) {
  // Update subscription status
  const { data, error } = await supabase
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    })
    .eq('polar_subscription_id', subscription.id)
    .select('user_id')
    .single();

  if (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }

  // Downgrade user to free tier (they keep access until period end)
  // WHY: Tier is on subscriptions table (updated above), not profiles.
  // Cancellation with ended_at is handled by the subscription status update.

  console.log('Subscription canceled:', subscription.id);
}

/**
 * Handle order.created event (for one-time payments or first subscription payment)
 */
async function handleOrderCreated(
  supabase: ReturnType<typeof createClient>,
  order: PolarOrder,
  customer: PolarCustomer | undefined
) {
  // Log the order for analytics
  console.log('Order created:', order.id, 'amount:', order.amount, order.currency);

  // Find user by customer email
  const email = customer?.email;
  if (!email) {
    console.warn('No email found for order:', order.id);
    return;
  }

  // WHY: Email is on auth.users, not profiles.
  const { data: authData } = await supabase.auth.admin.listUsers();
  const matchedUser = authData?.users?.find((u) => u.email === email);

  if (!matchedUser) {
    console.warn('No user found for order email:', email);
    return;
  }

  // Log to audit trail
  // WHY: audit_log uses `action` (audit_action enum), `resource_type`, `resource_id`
  // — not `target_type`/`target_id`. And 'subscription.payment' is not a valid enum
  // value — use 'subscription_changed'.
  await supabase.from('audit_log').insert({
    user_id: matchedUser.id,
    action: 'subscription_changed',
    resource_type: 'order',
    resource_id: order.id,
    metadata: {
      amount: order.amount,
      currency: order.currency,
      product_id: order.product_id,
    },
  });
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Get webhook secret
    const webhookSecret = Deno.env.get('POLAR_WEBHOOK_SECRET');
    if (!webhookSecret) {
      console.error('POLAR_WEBHOOK_SECRET not configured');
      return new Response('Server configuration error', { status: 500 });
    }

    // Get signature from header
    const signature = req.headers.get('polar-signature') || req.headers.get('x-polar-signature');
    if (!signature) {
      console.error('No signature in request');
      return new Response('Missing signature', { status: 401 });
    }

    // Read body
    const body = await req.text();

    // Verify signature
    const isValid = await verifySignature(body, signature, webhookSecret);
    if (!isValid) {
      console.error('Invalid signature');
      return new Response('Invalid signature', { status: 401 });
    }

    // Parse payload
    const payload: WebhookPayload = JSON.parse(body);
    console.log('Received webhook:', payload.type);

    // Create Supabase admin client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Handle event
    switch (payload.type) {
      case 'subscription.created':
        if (payload.data.subscription) {
          await handleSubscriptionCreated(
            supabase,
            payload.data.subscription,
            payload.data.customer
          );
        }
        break;

      case 'subscription.updated':
        if (payload.data.subscription) {
          await handleSubscriptionUpdated(supabase, payload.data.subscription);
        }
        break;

      case 'subscription.canceled':
        if (payload.data.subscription) {
          await handleSubscriptionCanceled(supabase, payload.data.subscription);
        }
        break;

      case 'order.created':
        if (payload.data.order) {
          await handleOrderCreated(
            supabase,
            payload.data.order,
            payload.data.customer
          );
        }
        break;

      default:
        console.log('Unhandled event type:', payload.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
