/**
 * Polar Webhook Handler
 *
 * POST /api/webhooks/polar
 *
 * @auth None (public endpoint — secured by HMAC-SHA256 signature verification)
 * @rateLimit 100 requests per 60 seconds per IP (Upstash Redis; skipped in dev/CI)
 *
 * Handles subscription lifecycle events from Polar:
 * - subscription.created  — individual plan (pro/power)
 * - subscription.updated  — individual plan seat/tier change OR team/business seat change
 * - subscription.canceled — individual plan OR team/business plan cancellation
 * - subscription.past_due — team/business payment failure
 * - order.created         — acknowledged, no state change
 *
 * Team-tier events are distinguished by the presence of `subscription.metadata.team_id`
 * in the Polar payload. When team_id is present, the event is routed to the team billing
 * handler instead of the individual subscription handler.
 *
 * Security controls (in order of application):
 * 1. Rate limiting (Upstash Redis — IP-based; see webhookLimiter below)
 * 2. HMAC-SHA256 signature verification via `verifyPolarSignatureOrThrow`
 * 3. DB-level idempotency via `polar_webhook_events` (ON CONFLICT DO NOTHING)
 * 4. Semantic validation (validateSeatCount, resolvePolarProductId)
 * 5. Admin client (service_role) — bypasses RLS after signature is verified
 *
 * @body {object} Polar webhook event (see PolarWebhookEventSchema)
 * @header polar-signature - HMAC-SHA256 hex digest of raw body (Polar sends both
 *   `polar-signature` and `x-polar-signature`; we check both in priority order)
 *
 * @returns 200 on success or acknowledged non-action (unknown type, dupe, no-op)
 * @returns 400 on malformed JSON or missing required payload fields
 * @returns 401 on missing or invalid HMAC signature
 * @returns 422 on semantic validation failure (unknown product ID, invalid seat count)
 * @returns 429 on rate limit exceeded
 * @returns 500 on database error (Polar will retry on 5xx — safe because of idempotency)
 *
 * @see https://docs.polar.sh/api-reference/webhooks
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import crypto from 'crypto';
import { z } from 'zod';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import {
  validatePolarEnv,
  resolvePolarProductId,
  type TeamBillingTier,
  type BillingCycle,
} from '@/lib/polar-env';
import {
  verifyPolarSignatureOrThrow,
  PolarSignatureError,
} from '@/lib/polar-webhook-signature';
import { validateSeatCount } from '@styrby/shared/billing';

// ============================================================================
// Cold-start env validation (team-tier Polar product IDs + secrets)
// ============================================================================

// WHY NEXT_PHASE gate: `next build` loads all route modules for page-data
// collection (static analysis / bundle splitting). In CI without the 6 Polar
// env vars set, the module-scope validatePolarEnv() call would throw during
// build-time module introspection and abort the build — not a runtime failure.
// Gating on NEXT_PHASE skips validation when Next.js is in its build phase;
// it still runs on every cold-start request in production and development.
// See: https://nextjs.org/docs/app/api-reference/next-config-js/generateBuildId
//
// WHY rethrow in non-test (inside the phase gate): swallowing the throw allows
// the route to continue loading on prod with missing billing env vars. The
// result is that resolvePolarProductId() returns undefined for every inbound
// team webhook, every event falls through to the "unknown product" audit-log
// branch, and billing state silently corrupts with no visible failure. The
// structured 500 that Next.js produces on a module-load error is surfaced by
// deploy-time health checks — far better than silent corruption.
//
// WHY suppress only in test (NODE_ENV === 'test'): existing solo-tier tests
// import this route without setting the six team-tier Polar env vars.
// validatePolarEnv is tested exhaustively in its own test file.
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  try {
    validatePolarEnv();
  } catch (err) {
    // WHY rethrow in non-test: prod cold-start MUST fail loudly on missing
    // billing env vars. Silently swallowing would let the webhook accept traffic
    // and misroute every team-tier subscription event into the "unknown product"
    // audit-log branch — billing state corruption with no visible failure.
    console.error('[polar-env] Startup validation failed:', (err as Error).message);
    if (process.env.NODE_ENV !== 'test') {
      throw err;
    }
  }
}

// ============================================================================
// Rate Limiting (Upstash Redis - distributed across all Vercel instances)
// ============================================================================

/**
 * Distributed rate limiter for the Polar webhook endpoint.
 *
 * WHY Upstash Redis instead of in-memory Map (A-002):
 * On Vercel's serverless platform, each request can land on a different instance.
 * An in-memory Map is per-instance, so a hostile IP distributing requests across
 * instances bypasses the limit entirely. Upstash Redis provides shared state
 * across all instances for a single source of truth.
 *
 * FALLBACK: If UPSTASH_REDIS_REST_URL is not set (local dev, CI), webhookLimiter
 * is null and rate limiting is skipped. This is acceptable because:
 * 1. The webhook signature check is the primary security control
 * 2. Local dev does not face real webhook traffic
 */
const webhookLimiter = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      }),
      limiter: Ratelimit.slidingWindow(100, '60 s'),
      prefix: 'styrby:polar-webhook',
      analytics: false,
    })
  : null;

/**
 * Polar webhook event types we handle.
 * Team-tier events reuse the same event type names — they are distinguished
 * by the presence of `metadata.team_id` in the subscription payload.
 */
type PolarEvent =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.past_due'
  | 'order.created';

// ============================================================================
// Team subscription payload schemas
// ============================================================================

/**
 * Schema for team subscription metadata embedded in Polar's subscription object.
 *
 * WHY metadata (not a top-level field): Polar's subscription model uses the
 * `metadata` map for arbitrary key-value pairs we set at checkout. The
 * webhook handler uses `metadata.team_id` as the routing key to distinguish
 * team-tier events from individual-tier events.
 */
const TeamSubscriptionMetadataSchema = z.object({
  team_id: z.string().min(1),
});

/**
 * Schema for a Polar subscription object when it carries team metadata.
 *
 * WHY `.passthrough()` on metadata: Polar may add metadata fields beyond
 * what we set at checkout. passthrough() preserves them without rejecting
 * the event, maintaining forward-compatibility.
 *
 * WHY prices array: Polar's per-seat model uses `quantity` for seat count
 * and `prices[0].product_id` for product resolution (tier + cycle mapping).
 */
const TeamSubscriptionDataSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'unpaid']),
    quantity: z.number().int().min(0),
    metadata: TeamSubscriptionMetadataSchema.passthrough(),
    prices: z
      .array(
        z.object({
          product_id: z.string().min(1),
        })
      )
      .min(1),
    current_period_start: z.string().optional(),
    current_period_end: z.string().optional(),
    canceled_at: z.string().optional(),
  })
  .passthrough();

/**
 * Polar's event_id field — used as the primary idempotency key.
 * Polar guarantees uniqueness per event delivery attempt; replays use the same ID.
 */
const PolarEventIdSchema = z.object({
  id: z.string().min(1),
});

/**
 * SHA-256 hash of a raw payload string. Used for polar_webhook_events.payload_hash.
 * Stored as hex to match the format used by Postgres's pgcrypto digest().
 */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
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
 * WHY: Subscription events drive billing state changes - we must guarantee
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

// ============================================================================
// Team subscription event handler
// ============================================================================

/**
 * Handles Polar webhook events for team-tier subscriptions.
 *
 * Called from the POST handler when `subscription.metadata.team_id` is
 * present, indicating this is a team-tier (not individual) subscription event.
 *
 * Responsibilities:
 * 1. Idempotency — inserts a row into `polar_webhook_events`; if the row
 *    already exists (ON CONFLICT DO NOTHING), returns 200 immediately.
 * 2. Product ID resolution — maps Polar product ID to (tier, cycle) via
 *    `resolvePolarProductId`. Returns 422 for unknown product IDs.
 * 3. Seat count validation — calls `validateSeatCount` from @styrby/shared.
 *    Returns 422 for invalid counts.
 * 4. Database update — writes billing state to `teams` table.
 * 5. Audit log — writes one or more `audit_log` rows for every state
 *    transition, satisfying SOC2 CC7.2 billing audit requirements.
 *
 * WHY service_role (admin client): the teams table has RLS policies that
 * restrict client-side writes. Webhook processing happens on a trusted server
 * after signature verification — using the admin client is correct here.
 * We NEVER use the admin client before signature verification passes.
 *
 * @param eventType - The Polar event type (subscription.updated, .canceled, .past_due)
 * @param teamId - The Styrby team UUID from subscription.metadata.team_id
 * @param subscriptionData - Validated Polar subscription payload
 * @param rawPayload - Raw request body string — used for payload_hash in idempotency table
 * @returns NextResponse with appropriate HTTP status
 */
async function handleTeamSubscriptionEvent(
  eventType: 'subscription.updated' | 'subscription.canceled' | 'subscription.past_due',
  teamId: string,
  subscriptionData: {
    id: string;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
    quantity: number;
    prices: Array<{ product_id: string }>;
    current_period_start?: string;
    current_period_end?: string;
    canceled_at?: string;
    [key: string]: unknown;
  },
  rawPayload: string
): Promise<Response> {
  // WHY admin client here and not before: createAdminClient() uses
  // SUPABASE_SERVICE_ROLE_KEY which bypasses RLS. We only call this after
  // HMAC signature verification has confirmed the request is authentic.
  const supabase = createAdminClient();
  const isDev = process.env.NODE_ENV === 'development';

  // --------------------------------------------------------------------------
  // 1. Idempotency — attempt to record this event in polar_webhook_events.
  //    If the row already exists, Polar is retrying a previously-processed
  //    event. Return 200 without re-processing.
  // --------------------------------------------------------------------------

  // WHY we need the top-level event ID, not subscription.id: Polar's idempotency
  // key is the webhook event UUID (top-level `id` field), not the subscription ID.
  // The subscription ID can appear in multiple distinct events (created, updated,
  // canceled) — those must each be processed exactly once as separate events.
  // We parse it safely from the raw payload to avoid trusting the already-cast
  // `event` shape for a security-critical dedup key.
  const rawParsed = JSON.parse(rawPayload) as Record<string, unknown>;
  const eventIdResult = PolarEventIdSchema.safeParse(rawParsed);
  if (!eventIdResult.success) {
    console.error('Team event missing top-level id field — cannot enforce idempotency');
    return NextResponse.json({ error: 'Invalid payload: missing event id' }, { status: 400 });
  }
  const eventId = eventIdResult.data.id;
  const payloadHash = sha256Hex(rawPayload);

  // ON CONFLICT (event_id) DO NOTHING via upsert with ignoreDuplicates: true.
  //
  // WHY upsert + ignoreDuplicates (not raw insert): supabase-js v2 does not
  // expose a fluent .onConflict().ignore() API. `upsert` with ignoreDuplicates
  // emits `INSERT ... ON CONFLICT (event_id) DO NOTHING` under the hood.
  // We use select() to get RETURNING semantics: if the event was already
  // processed, the insert is a no-op and `data` is an empty array; if it is
  // new, `data` contains the inserted row. This lets us detect duplicates
  // without a separate SELECT query, saving one DB round-trip.
  //
  // SQL equivalent:
  //   INSERT INTO polar_webhook_events (event_id, event_type, subscription_id, payload_hash)
  //   VALUES ($1, $2, $3, $4)
  //   ON CONFLICT (event_id) DO NOTHING
  //   RETURNING event_id;
  const { data: insertedRows, error: insertError } = await supabase
    .from('polar_webhook_events')
    .upsert(
      {
        event_id: eventId,
        event_type: eventType,
        subscription_id: subscriptionData.id,
        payload_hash: payloadHash,
      },
      { onConflict: 'event_id', ignoreDuplicates: true }
    )
    .select('event_id');

  if (insertError) {
    // A DB error here (not a conflict) means we cannot safely enforce idempotency.
    // Return 500 so Polar retries — the retry will either succeed or hit the
    // duplicate key (if the first attempt actually committed before the error).
    console.error('polar/route: failed to record team webhook event:', insertError.message);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  if (!insertedRows || insertedRows.length === 0) {
    // Conflict — this event was already processed. Acknowledge and return.
    if (isDev) console.log(`polar/route: duplicate team event ${eventId}, skipping`);
    return NextResponse.json({ received: true });
  }

  // --------------------------------------------------------------------------
  // 2. Product ID resolution (subscription.updated only)
  //    Map Polar product ID → (tier, cycle) for the teams table update.
  // --------------------------------------------------------------------------

  let resolvedTier: TeamBillingTier | null = null;
  let resolvedCycle: BillingCycle | null = null;

  if (eventType === 'subscription.updated') {
    const productId = subscriptionData.prices[0]?.product_id ?? '';
    const mapping = resolvePolarProductId(productId);

    if (!mapping) {
      // Unknown product ID — could be a test product or a future plan.
      // Return 422 (not 200) so the webhook appears as a semantic error in
      // Polar's delivery dashboard, prompting ops investigation.
      console.error(
        `polar/route: unknown Polar product_id '${productId}' for team subscription`
      );

      // WHY audit_log even on failure: the attempt to process an unknown product
      // is auditable. If this is a misconfiguration (wrong env var), the audit
      // trail helps ops identify when the gap started.
      await supabase.from('audit_log').insert({
        action: 'team_subscription_updated',
        target_type: 'team',
        target_id: teamId,
        metadata: {
          error: 'unknown_product_id',
          polar_subscription_id: subscriptionData.id,
          event_id: eventId,
        },
      });

      return NextResponse.json(
        { error: 'Unknown product ID — cannot resolve billing tier' },
        { status: 422 }
      );
    }

    resolvedTier = mapping.tier;
    resolvedCycle = mapping.cycle;
  }

  // --------------------------------------------------------------------------
  // 3. Seat count validation (subscription.updated only)
  // --------------------------------------------------------------------------

  const seatCount = subscriptionData.quantity;

  if (eventType === 'subscription.updated' && resolvedTier) {
    const validation = validateSeatCount(resolvedTier, seatCount);
    if (!validation.ok) {
      console.error(
        `polar/route: invalid seat count ${seatCount} for tier '${resolvedTier}': ${validation.reason}`
      );

      await supabase.from('audit_log').insert({
        action: 'team_subscription_updated',
        target_type: 'team',
        target_id: teamId,
        metadata: {
          error: 'invalid_seat_count',
          seat_count: seatCount,
          tier: resolvedTier,
          reason: validation.reason,
          min_seats: validation.minSeats,
          polar_subscription_id: subscriptionData.id,
          event_id: eventId,
        },
      });

      return NextResponse.json(
        { error: `Invalid seat count: ${validation.reason}` },
        { status: 422 }
      );
    }
  }

  // --------------------------------------------------------------------------
  // 4. Database update — write billing state to teams table
  // --------------------------------------------------------------------------

  try {
    if (eventType === 'subscription.updated' && resolvedTier && resolvedCycle) {
      // Read current seat_cap so we can detect direction of change for audit log.
      const { data: currentTeam } = await supabase
        .from('teams')
        .select('seat_cap, billing_tier, billing_status')
        .eq('id', teamId)
        .single();

      const oldSeatCap: number = currentTeam?.seat_cap ?? 0;

      // Map Polar subscription status to our billing_status enum values.
      // WHY explicit mapping (not passthrough): Polar's status values do not
      // align 1:1 with our CHECK constraint values. An unmapped Polar status
      // would cause a Postgres constraint violation (500), which Polar would
      // retry indefinitely. Explicit mapping returns 500 only on genuine DB
      // errors, not on Polar API version changes.
      const billingStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | 'grace_period' =
        subscriptionData.status === 'trialing'
          ? 'trialing'
          : subscriptionData.status === 'active'
          ? 'active'
          : subscriptionData.status === 'past_due'
          ? 'past_due'
          : subscriptionData.status === 'canceled'
          ? 'canceled'
          : 'active'; // fallback for 'unpaid' — treat as active until a .past_due event arrives

      const { error: updateError } = await supabase
        .from('teams')
        .update({
          seat_cap: seatCount,
          billing_tier: resolvedTier,
          billing_status: billingStatus,
          billing_cycle: resolvedCycle,
          polar_subscription_id: subscriptionData.id,
        })
        .eq('id', teamId);

      if (updateError) {
        console.error('polar/route: failed to update team billing state:', updateError.message);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      // Primary audit log — every subscription update is a material billing event.
      // WHY Record<string, unknown>[] type annotation: without it, TypeScript infers
      // the array as a single-element tuple with action='team_subscription_updated'.
      // Pushing rows with different action literals then fails type checking because
      // the tuple type is incompatible with the new element's action literal.
      // The explicit annotation lets TS verify each row's shape independently.
      const auditRows: Record<string, unknown>[] = [
        {
          action: 'team_subscription_updated',
          target_type: 'team',
          target_id: teamId,
          metadata: {
            polar_subscription_id: subscriptionData.id,
            event_id: eventId,
            tier: resolvedTier,
            cycle: resolvedCycle,
            billing_status: billingStatus,
            old_seat_cap: oldSeatCap,
            new_seat_cap: seatCount,
          },
        },
      ];

      // Secondary audit rows for seat count direction changes.
      // WHY separate rows (not just metadata): audit_log action values are typed
      // (audit_action enum) and queryable. Separate rows allow ops to aggregate
      // "how many seat expansions this quarter?" without parsing JSON metadata.
      if (seatCount > oldSeatCap) {
        auditRows.push({
          action: 'team_seat_count_increased',
          target_type: 'team',
          target_id: teamId,
          metadata: {
            polar_subscription_id: subscriptionData.id,
            event_id: eventId,
            old_seat_cap: oldSeatCap,
            new_seat_cap: seatCount,
            delta: seatCount - oldSeatCap,
          },
        });
      } else if (seatCount < oldSeatCap) {
        auditRows.push({
          action: 'team_seat_count_decreased',
          target_type: 'team',
          target_id: teamId,
          metadata: {
            polar_subscription_id: subscriptionData.id,
            event_id: eventId,
            old_seat_cap: oldSeatCap,
            new_seat_cap: seatCount,
            delta: oldSeatCap - seatCount,
          },
        });
      }

      const { error: auditError } = await supabase.from('audit_log').insert(auditRows);
      if (auditError) {
        // WHY warn but not return 500: the billing state update succeeded.
        // An audit log failure must not cause Polar to retry the event and
        // potentially double-update billing state. The idempotency check
        // already recorded the event — the audit gap is recoverable from
        // polar_webhook_events by ops; a retry would re-process and re-audit
        // with a new event_id (Polar generates a new ID per delivery attempt).
        console.error('polar/route: audit_log insert failed (non-fatal):', auditError.message);
      }

      if (isDev) console.log(`polar/route: team ${teamId} billing updated — ${oldSeatCap}→${seatCount} seats`);
    } else if (eventType === 'subscription.canceled') {
      // WHY keep current seat_cap on cancel (not zero it): members need 7 days
      // of continued access. Setting seat_cap to 0 immediately would lock out
      // all team members. The cron job that runs after grace_period_ends_at
      // resets seat_cap as part of the downgrade flow.
      const { error: updateError } = await supabase
        .from('teams')
        .update({
          billing_status: 'canceled',
          grace_period_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq('id', teamId);

      if (updateError) {
        console.error('polar/route: failed to cancel team billing state:', updateError.message);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      const { error: auditError } = await supabase.from('audit_log').insert([
        {
          action: 'team_subscription_canceled',
          target_type: 'team',
          target_id: teamId,
          metadata: {
            polar_subscription_id: subscriptionData.id,
            event_id: eventId,
            canceled_at: subscriptionData.canceled_at ?? new Date().toISOString(),
          },
        },
        {
          action: 'team_billing_grace_period_entered',
          target_type: 'team',
          target_id: teamId,
          metadata: {
            polar_subscription_id: subscriptionData.id,
            event_id: eventId,
            grace_period_days: 7,
            grace_period_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ]);

      if (auditError) {
        console.error('polar/route: audit_log insert failed on cancel (non-fatal):', auditError.message);
      }

      if (isDev) console.log(`polar/route: team ${teamId} subscription canceled, grace period set`);
    } else if (eventType === 'subscription.past_due') {
      // WHY 3-day grace for past_due (vs 7-day for cancel): past_due is a
      // payment failure, not an intentional cancellation. 3 days gives the
      // customer time to update their payment method; if they do, Polar sends
      // a subscription.updated event restoring 'active' status and the cron
      // job ignores the grace_period_ends_at. If they don't, the cron job
      // downgrades after 3 days.
      const { error: updateError } = await supabase
        .from('teams')
        .update({
          billing_status: 'past_due',
          grace_period_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq('id', teamId);

      if (updateError) {
        console.error('polar/route: failed to set team past_due state:', updateError.message);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      const { error: auditError } = await supabase.from('audit_log').insert({
        action: 'team_billing_past_due',
        target_type: 'team',
        target_id: teamId,
        metadata: {
          polar_subscription_id: subscriptionData.id,
          event_id: eventId,
          grace_period_days: 3,
          grace_period_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      if (auditError) {
        console.error('polar/route: audit_log insert failed on past_due (non-fatal):', auditError.message);
      }

      if (isDev) console.log(`polar/route: team ${teamId} billing past_due, 3-day grace period set`);
    }
  } catch (dbError) {
    console.error(
      'polar/route: unexpected error in team handler:',
      dbError instanceof Error ? dbError.message : 'unknown'
    );
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

export async function POST(request: Request) {
  // Rate limit check (A-002: distributed via Upstash Redis)
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (webhookLimiter) {
    try {
      const { success } = await webhookLimiter.limit(ip);
      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': '60' } }
        );
      }
    } catch {
      // WHY: If Redis is temporarily unreachable, allow the webhook through.
      // The signature verification is the primary security control, not rate
      // limiting. Blocking all webhooks on Redis failure would cause Polar to
      // retry indefinitely and potentially miss subscription state changes.
    }
  }

  // Get raw body for signature verification.
  // WHY before headers(): request.text() consumes the body stream; it must be
  // called before any other awaited read or the body is gone.
  const payload = await request.text();

  // Verify HMAC-SHA256 signature via the canonical library.
  // WHY verifyPolarSignatureOrThrow (not private verifySignature): using one
  // implementation eliminates the DRY risk of two diverging HMAC paths.
  // The library version reads POLAR_WEBHOOK_SECRET from env internally,
  // performs the length pre-check, and uses crypto.timingSafeEqual.
  const headersList = await headers();
  const signature =
    headersList.get('polar-signature') ?? headersList.get('x-polar-signature') ?? '';

  try {
    verifyPolarSignatureOrThrow(payload, signature);
  } catch (e) {
    if (e instanceof PolarSignatureError) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    // Unexpected error (e.g. POLAR_WEBHOOK_SECRET missing entirely — should have
    // been caught by validatePolarEnv() at cold-start, but be defensive).
    console.error('polar/route: unexpected error during signature verification:', e);
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
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

    // WHY: Return 200 for unrecognized event types - Polar retries on non-2xx
    // responses, so rejecting unknown types would cause infinite retry loops.
    const knownTypes = new Set<string>([
      'subscription.created',
      'subscription.updated',
      'subscription.canceled',
      'subscription.past_due',
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

  // ============================================================================
  // Team-tier routing: if subscription.metadata.team_id is present, delegate
  // to the team billing handler BEFORE the individual-plan switch.
  //
  // WHY check here (after signature + schema validation, before the switch):
  // Team and individual events share the same Polar event types but require
  // entirely different database logic. Routing early keeps the individual-plan
  // switch clean and prevents accidental team→subscriptions table writes.
  //
  // WHY metadata.team_id as the discriminator (not product_id alone):
  // Team product IDs overlap with the product_id resolver; a team account
  // upgrading could also match individual-tier product IDs if we relied on
  // product_id alone. metadata.team_id is an explicit signal set at checkout
  // by the Styrby frontend — it cannot be coincidentally present.
  // ============================================================================

  const rawParsed = JSON.parse(payload) as Record<string, unknown>;
  const rawData = rawParsed.data as Record<string, unknown> | undefined;
  const rawMetadata = rawData?.metadata as Record<string, unknown> | undefined;
  const teamId = rawMetadata?.team_id as string | undefined;

  if (
    teamId &&
    (event.type === 'subscription.updated' ||
      event.type === 'subscription.canceled' ||
      event.type === 'subscription.past_due')
  ) {
    // Parse the full team subscription payload with the stricter schema.
    const teamDataResult = TeamSubscriptionDataSchema.safeParse(rawData);
    if (!teamDataResult.success) {
      console.error(
        'Team subscription event missing required fields:',
        teamDataResult.error.message
      );
      return NextResponse.json({ error: 'Invalid team subscription payload' }, { status: 400 });
    }

    return handleTeamSubscriptionEvent(
      event.type,
      teamId,
      teamDataResult.data,
      payload
    );
  }

  const supabase = createAdminClient();

  try {
    switch (event.type) {
      case 'subscription.created':
      case 'subscription.updated': {
        const { data } = event;
        const isDev = process.env.NODE_ENV === 'development';

        // FIX-005 / PERF-009: Resolve profileId via user_id and customer_id lookups.
        //
        // WHY parallel strategy: when both identifiers are present we fire both
        // queries concurrently and pick the first that returns a valid ID.
        // This shaves one full round-trip in the common case where user_id is set
        // and the profile exists - the customer_id result is simply discarded.
        // When only one identifier is available we fall through to the single
        // query path without wasting an unnecessary network call.
        let profileId: string | null = null;

        if (data.user_id && data.customer_id) {
          // Both identifiers present - fire in parallel, use first non-null result
          const [profileResult, customerResult] = await Promise.all([
            supabase.from('profiles').select('id').eq('id', data.user_id).single(),
            supabase
              .from('subscriptions')
              .select('user_id')
              .eq('polar_customer_id', data.customer_id)
              .single(),
          ]);
          profileId = profileResult.data?.id || customerResult.data?.user_id || null;
        } else if (data.user_id) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', data.user_id)
            .single();
          profileId = profile?.id || null;
        } else if (data.customer_id) {
          // Fallback: look up by existing polar_customer_id in subscriptions
          const { data: existingByCustomer } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('polar_customer_id', data.customer_id)
            .single();
          profileId = existingByCustomer?.user_id || null;
        }

        if (!profileId) {
          if (isDev) console.log('No user found for subscription event - Polar may be ahead of signup');
          return NextResponse.json({ received: true });
        }

        // WHY: Reject events with unrecognized product IDs rather than
        // defaulting to 'free' which would silently downgrade paying users.
        const productId = data.product_id || '';
        const tier = getTierFromProductId(productId);
        if (!tier) {
          console.error(`Unrecognized Polar product_id: ${productId} - skipping upsert to prevent tier corruption`);
          return NextResponse.json({ received: true });
        }

        // FIX-007: Downgrade protection - don't silently downgrade paid users
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
          // SEC-CFG-001 FIX: Log the warning with sanitized fields only.
          // WHY: console.warn(error) or logging raw objects can leak full stack
          // traces, internal IDs, or structured data to log aggregation systems
          // that may have less strict access controls than the application.
          // Structured logging with explicit fields prevents accidental leakage.
          console.warn(
            'Webhook processing warning: downgrade detected',
            `user tier='${existingSub.tier}' event tier='${tier}' - skipping upsert`
          );
          return NextResponse.json({ received: true });
        }

        // Upsert subscription
        // WHY: is_annual boolean matches the actual subscriptions table schema.
        // WHY onConflict: 'polar_subscription_id' - webhooks must be idempotent.
        // Polar may deliver the same subscription.created event more than once
        // (retries, network issues). Conflicting on polar_subscription_id ensures
        // that a duplicate event updates the existing row rather than creating a
        // second subscription for the user, which would corrupt billing state.
        // Using user_id here was wrong - a user can have multiple historical
        // subscriptions and the conflict target must uniquely identify THIS
        // subscription, not the user.
        await supabase.from('subscriptions').upsert(
          {
            user_id: profileId,
            polar_subscription_id: data.id,
            polar_customer_id: data.customer_id,
            polar_product_id: productId,
            tier,
            is_annual: getBillingCycleFromProductId(productId) === 'annual',
            // SEC-LOGIC-008: Map Polar statuses to our subscriptions table status column.
            // The subscriptions table supports 'active' and 'canceled' statuses.
            // 'past_due' is intentionally mapped to 'canceled' because our schema does
            // not have a 'past_due' status - past_due subscriptions have lapsed billing
            // and should be treated as no longer active. If the payment succeeds later,
            // Polar sends a subscription.updated event with status='active' which
            // restores access. This is a deliberate lossy mapping, not an oversight.
            status: data.status === 'active' ? 'active' : 'canceled',
            current_period_start: data.current_period_start,
            current_period_end: data.current_period_end,
            cancel_at_period_end: data.cancel_at_period_end || false,
          },
          {
            onConflict: 'polar_subscription_id',
          }
        );

        if (isDev) console.log('Subscription upserted successfully');
        break;
      }

      case 'subscription.canceled': {
        const { data } = event;
        const isDev = process.env.NODE_ENV === 'development';

        // WHY: When a subscription is canceled, access should continue until the
        // end of the paid billing period - not cut off immediately. We record
        // current_period_end (or ended_at as a fallback) so the scheduled cron
        // job can check this timestamp and downgrade the user's tier to 'free'
        // only after the period expires. Downgrading the tier here immediately
        // would be a billing violation - the user paid for the full period.
        //
        // CRON JOB REQUIRED: A scheduled job must run daily and execute:
        //   UPDATE subscriptions
        //   SET tier = 'free'
        //   WHERE status = 'canceled'
        //     AND current_period_end < NOW()
        //     AND tier != 'free';
        // This enforces the grace period and prevents unauthorized access after
        // the subscription truly ends.
        // WHY: Polar's webhook payload includes current_period_end for active
        // subscriptions. We also check ended_at via a safe cast in case the
        // payload schema evolves - defensive coding against provider changes.
        const periodEnd =
          data.current_period_end ||
          (data as Record<string, unknown>).ended_at as string | undefined ||
          null;

        await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            canceled_at: data.canceled_at || new Date().toISOString(),
            // Preserve the paid-through date so the cron job knows when to
            // actually downgrade the tier. Do not null this out - it is the
            // authoritative "access until" timestamp.
            ...(periodEnd ? { current_period_end: periodEnd } : {}),
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
