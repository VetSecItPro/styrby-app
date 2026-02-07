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
import { z } from 'zod';

// ============================================================================
// Rate Limiting
// ============================================================================

/** Rate limiting configuration */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;

/** In-memory rate limit tracking */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/**
 * Tracks the last time we swept expired entries from the rate limit map.
 * WHY: Without periodic cleanup, unique IPs accumulate forever in the Map,
 * causing unbounded memory growth on long-lived serverless instances.
 */
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute between sweeps

/**
 * Removes expired entries from the rate limit map.
 * WHY: Each unique IP that hits the webhook creates a Map entry. In a
 * long-running process, stale entries from IPs that never return would
 * accumulate indefinitely without periodic eviction.
 */
function cleanupRateLimitMap(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;

  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
  lastCleanup = now;
}

/**
 * Checks if a request should be rate limited.
 * WHY: Prevents abuse of the webhook endpoint which uses an admin Supabase client.
 *
 * @param ip - Client IP address
 * @returns True if the request should be rejected
 */
function isRateLimited(ip: string): boolean {
  cleanupRateLimitMap();

  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

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
 *
 * WHY: Returns null for unrecognized product IDs instead of defaulting to 'free'.
 * This prevents accidental tier downgrades when Polar sends an unexpected
 * product_id (new product, format change, null value). Callers must handle
 * the null case explicitly rather than silently overwriting a paid tier.
 *
 * @param productId - The Polar product ID from the webhook payload
 * @returns The tier name, or null if the product ID is unrecognized
 */
function getTierFromProductId(productId: string): 'pro' | 'power' | null {
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
  return null;
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

// ============================================================================
// Webhook Payload Validation
// ============================================================================

/**
 * Base schema for all Polar webhook events.
 * WHY: After signature verification proves the payload is authentic, we still
 * need structural validation to catch API version mismatches or corrupted
 * payloads before they hit our database logic. Using .passthrough() ensures
 * we don't reject events when Polar adds new fields.
 */
const PolarWebhookEventSchema = z
  .object({
    type: z.string(),
    data: z.object({}).passthrough(),
  })
  .passthrough();

/**
 * Schema for subscription event data (created, updated, revoked/canceled).
 * WHY: Subscription events drive billing state changes — we must guarantee
 * the minimum fields exist before upserting into the subscriptions table.
 */
const SubscriptionDataSchema = z
  .object({
    id: z.string(),
    status: z.string(),
  })
  .passthrough();

/** Event types that carry subscription data requiring validation */
const SUBSCRIPTION_EVENT_TYPES = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.revoked',
  'subscription.canceled',
]);

export async function POST(request: Request) {
  // Rate limit check
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }

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

  // Parse and validate the event
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
    const parsed = JSON.parse(payload);

    // Validate top-level event structure
    const eventResult = PolarWebhookEventSchema.safeParse(parsed);
    if (!eventResult.success) {
      console.error('Webhook payload failed schema validation:', eventResult.error.message);
      return NextResponse.json(
        { error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    // For subscription events, validate the data object has required fields
    if (SUBSCRIPTION_EVENT_TYPES.has(eventResult.data.type)) {
      const dataResult = SubscriptionDataSchema.safeParse(eventResult.data.data);
      if (!dataResult.success) {
        console.error(
          `Subscription event ${eventResult.data.type} missing required data fields:`,
          dataResult.error.message
        );
        return NextResponse.json(
          { error: 'Invalid subscription data' },
          { status: 400 }
        );
      }
    }

    // WHY: Return 200 for unrecognized event types — Polar retries on non-2xx
    // responses, so rejecting unknown types would cause infinite retry loops.
    const knownTypes = new Set<string>([
      'subscription.created',
      'subscription.updated',
      'subscription.canceled',
      'order.created',
    ]);
    if (!knownTypes.has(eventResult.data.type)) {
      console.warn(`Received unrecognized Polar event type: ${eventResult.data.type}`);
      return NextResponse.json({ received: true });
    }

    event = eventResult.data as typeof event;
  } catch {
    console.error('Invalid webhook payload (malformed JSON)');
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
        const isDev = process.env.NODE_ENV === 'development';

        // FIX-005: Try user_id first, fall back to customer_id lookup
        // WHY: Polar's user_id field is optional and may change format.
        // Falling back to customer_id-based lookup ensures we can still
        // map subscriptions from existing records when user_id is absent.
        let profileId: string | null = null;

        if (data.user_id) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', data.user_id)
            .single();
          profileId = profile?.id || null;
        }

        // Fallback: look up by existing polar_customer_id in subscriptions
        if (!profileId && data.customer_id) {
          const { data: existingByCustomer } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('polar_customer_id', data.customer_id)
            .single();
          if (existingByCustomer) {
            profileId = existingByCustomer.user_id;
          }
        }

        if (!profileId) {
          if (isDev) console.log('No user found for subscription event — Polar may be ahead of signup');
          return NextResponse.json({ received: true });
        }

        // WHY: Reject events with unrecognized product IDs rather than
        // defaulting to 'free' which would silently downgrade paying users.
        const productId = data.product_id || '';
        const tier = getTierFromProductId(productId);
        if (!tier) {
          console.error(`Unrecognized Polar product_id: ${productId} — skipping upsert to prevent tier corruption`);
          return NextResponse.json({ received: true });
        }

        // FIX-007: Downgrade protection — don't silently downgrade paid users
        // WHY: If a user is on 'power' and this event says 'pro', it may be
        // a stale webhook or Polar issue. Log a warning and skip the downgrade.
        const tierRank: Record<string, number> = { free: 0, pro: 1, power: 2 };
        const { data: existingSub } = await supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', profileId)
          .single();

        if (
          existingSub &&
          existingSub.status === 'active' &&
          (tierRank[tier] ?? 0) < (tierRank[existingSub.tier] ?? 0)
        ) {
          console.warn(
            `Downgrade detected: user ${profileId} is on '${existingSub.tier}' but event has '${tier}'. ` +
            'Skipping upsert to prevent accidental downgrade. Process manually if intentional.'
          );
          return NextResponse.json({ received: true });
        }

        // Upsert subscription
        // WHY: is_annual boolean matches the actual subscriptions table schema
        await supabase.from('subscriptions').upsert(
          {
            user_id: profileId,
            polar_subscription_id: data.id,
            polar_customer_id: data.customer_id,
            polar_product_id: productId,
            tier,
            is_annual: getBillingCycleFromProductId(productId) === 'annual',
            status: data.status === 'active' ? 'active' : 'canceled',
            current_period_start: data.current_period_start,
            current_period_end: data.current_period_end,
            cancel_at_period_end: data.cancel_at_period_end || false,
          },
          {
            onConflict: 'user_id',
          }
        );

        if (isDev) console.log('Subscription upserted successfully');
        break;
      }

      case 'subscription.canceled': {
        const { data } = event;
        const isDev = process.env.NODE_ENV === 'development';

        // Update subscription status
        await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            canceled_at: data.canceled_at || new Date().toISOString(),
          })
          .eq('polar_subscription_id', data.id);

        if (isDev) console.log('Subscription canceled successfully');
        break;
      }

      case 'order.created': {
        const isDev = process.env.NODE_ENV === 'development';
        if (isDev) console.log('Order created event received');
        break;
      }

      default: {
        const isDev = process.env.NODE_ENV === 'development';
        if (isDev) console.log(`Unhandled event type: ${event.type}`);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 }
    );
  }
}
