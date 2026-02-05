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
