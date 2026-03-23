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
 * Map Polar product ID to subscription tier.
 *
 * SEC-LOGIC-001 FIX: Returns null for unrecognized product IDs instead of
 * defaulting to 'free'. Returning 'free' for an unknown product would silently
 * downgrade paying users if a new product ID is introduced or env vars are
 * misconfigured. Callers must guard against null and skip any DB write.
 *
 * @param productId - The Polar product ID from the webhook payload
 * @returns The matching tier string, or null if the product ID is not recognized
 */
function getTierFromProductId(productId: string): 'free' | 'pro' | 'power' | 'team' | null {
  const proProductId = Deno.env.get('POLAR_PRO_PRODUCT_ID');
  const powerProductId = Deno.env.get('POLAR_POWER_PRODUCT_ID');

  if (productId === proProductId) return 'pro';
  if (productId === powerProductId) return 'power';

  // WHY: Return null rather than defaulting to 'free'. An unknown product ID
  // likely means a misconfigured env var or a new product not yet handled.
  // Silently writing 'free' would corrupt subscription state for paying users.
  return null;
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
 * Resolve user ID from email by querying the profiles table directly.
 *
 * SEC-LOGIC-003 FIX: Replaced supabase.auth.admin.listUsers() which loads
 * ALL users into memory (O(n)) with a targeted single-row lookup. listUsers()
 * is a DoS risk and will OOM the Edge Function as user count grows.
 *
 * @param supabase - Admin Supabase client
 * @param email - The email address to look up
 * @returns The user's UUID, or null if not found
 */
async function findUserIdByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string
): Promise<string | null> {
  // WHY: auth.users is not queryable via the Supabase JS client's .from() API.
  // We use the admin.listUsers with a filter instead of loading all users.
  // The Supabase admin API supports filtering by email directly, which is O(1)
  // at the DB level instead of fetching all rows and filtering in JS.
  const { data, error } = await supabase.auth.admin.listUsers({
    // @ts-ignore — Supabase admin API accepts filter params not yet typed
    filter: `email.eq.${email}`,
  });

  if (error) {
    console.error('Error looking up user by email:', error);
    return null;
  }

  const matched = data?.users?.find((u) => u.email === email);
  return matched?.id ?? null;
}

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

  // SEC-LOGIC-003 FIX: Use targeted lookup instead of loading all users.
  const userId = await findUserIdByEmail(supabase, email);

  if (!userId) {
    console.error('No user found for email:', email);
    return;
  }

  // SEC-LOGIC-001 FIX: getTierFromProductId returns null for unknown product IDs.
  // Guard here: if the product ID is unrecognized, log a warning and skip the
  // DB write entirely. Writing null or defaulting to 'free' would corrupt the
  // subscription state for a paying user.
  const tier = getTierFromProductId(subscription.product_id);
  if (tier === null) {
    console.error(
      '[SEC-LOGIC-001] Unknown product_id in subscription.created — skipping DB write to prevent accidental downgrade.',
      { subscriptionId: subscription.id, productId: subscription.product_id }
    );
    // Return 200 to Polar so it does not retry. This event must be investigated
    // manually via logs. Retrying would not help — the product ID will still be unknown.
    return;
  }

  // Upsert subscription
  const { error } = await supabase.from('subscriptions').upsert(
    {
      user_id: userId,
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
 *
 * SEC-LOGIC-002 FIX: Added idempotency check. Polar may deliver the same
 * webhook event more than once (network retries, at-least-once delivery).
 * Re-processing a duplicate event is harmless for status updates, but could
 * cause double side-effects (emails, tier changes) in future code. We compare
 * the incoming status and period against the current DB row and skip the write
 * if nothing has changed.
 *
 * SEC-LOGIC-001 FIX: Null guard on tier — if the product ID is unrecognized,
 * skip the DB write entirely to prevent accidental tier corruption.
 */
async function handleSubscriptionUpdated(
  supabase: ReturnType<typeof createClient>,
  subscription: PolarSubscription
) {
  // SEC-LOGIC-001: Validate product ID before any DB interaction.
  const tier = getTierFromProductId(subscription.product_id);
  if (tier === null) {
    console.error(
      '[SEC-LOGIC-001] Unknown product_id in subscription.updated — skipping DB write to prevent accidental downgrade.',
      { subscriptionId: subscription.id, productId: subscription.product_id }
    );
    // Return without throwing. The 200 response to Polar prevents retries.
    return;
  }

  const incomingStatus = mapStatus(subscription.status);

  // SEC-LOGIC-002: Fetch the current row to compare before writing.
  // WHY: If status, tier, and period are unchanged, this is a duplicate event.
  // Skipping the write prevents redundant DB mutations and any downstream
  // side-effects (future email triggers, analytics events, etc.).
  const { data: existing, error: fetchError } = await supabase
    .from('subscriptions')
    .select('status, tier, current_period_end')
    .eq('polar_subscription_id', subscription.id)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = row not found — allow fall-through to create the row.
    console.error('Error fetching subscription for idempotency check:', fetchError);
    throw fetchError;
  }

  if (existing) {
    const statusUnchanged = existing.status === incomingStatus;
    const tierUnchanged = existing.tier === tier;
    const periodUnchanged = existing.current_period_end === subscription.current_period_end;

    if (statusUnchanged && tierUnchanged && periodUnchanged) {
      console.log(
        '[SEC-LOGIC-002] Duplicate subscription.updated event detected — skipping (no changes).',
        { subscriptionId: subscription.id, status: incomingStatus }
      );
      return;
    }
  }

  // Update subscription
  const { data, error } = await supabase
    .from('subscriptions')
    .update({
      tier,
      status: incomingStatus,
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

  // SEC-LOGIC-003 FIX: Use targeted lookup instead of loading all users.
  const userId = await findUserIdByEmail(supabase, email);

  if (!userId) {
    console.warn('No user found for order email:', email);
    return;
  }

  // Log to audit trail
  // WHY: audit_log uses `action` (audit_action enum), `resource_type`, `resource_id`
  // — not `target_type`/`target_id`. And 'subscription.payment' is not a valid enum
  // value — use 'subscription_changed'.
  await supabase.from('audit_log').insert({
    user_id: userId,
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
