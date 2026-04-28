/**
 * POST /api/billing/checkout
 *
 * Creates a Polar checkout session for a per-seat team or business plan.
 * Called by the /checkout/team page CTA. Returns a Polar hosted checkout URL;
 * the browser then redirects to Polar's payment page.
 *
 * On successful payment, Polar sends a webhook to /api/webhooks/polar (Unit B),
 * which updates teams.seat_cap, billing_tier, billing_status, and billing_cycle.
 * This route does NOT update any subscription state — that is the webhook's job.
 *
 * @auth Required - Supabase Auth JWT via cookie (web) OR Authorization: Bearer
 *   <access_token> header (mobile). Mirrors the pattern from /api/invitations/accept.
 *
 * @rateLimit 5 requests per minute (RATE_LIMITS.checkout) — Polar API has costs.
 *
 * @body {
 *   team_id: string (UUID),
 *   tier:    'team' | 'business',
 *   cycle:   'monthly' | 'annual',
 *   seats:   integer (>= tier minimum)
 * }
 *
 * @returns 200 { checkout_url: string }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 422 { error: 'INVALID_SEATS', message: string, minSeats: number }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 502 { error: 'UPSTREAM_ERROR', message: string }  — Polar API failure
 *
 * Security:
 *   - All params re-validated server-side regardless of what the page sent.
 *   - Team admin membership verified via Supabase (user must be owner/admin).
 *   - POLAR_ACCESS_TOKEN never logged (OWASP ASVS V7.1.1 — secrets not in logs).
 *   - service_role used ONLY for audit_log insert (after auth + authz pass).
 *   - Enterprise tier rejected at schema layer (no self-service for enterprise).
 *
 * SOC2 CC6.1: Admin-only action enforced before any Polar API call.
 * SOC2 CC7.2: audit_log entry created for every checkout initiation.
 *
 * @module api/billing/checkout/team/route
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { createServerClient } from '@supabase/ssr';
import { Polar } from '@polar-sh/sdk';
import {
  validateSeatCount,
  type BillableTier,
} from '@styrby/shared/billing';
import {
  getPolarProductId,
  type TeamBillingTier,
  type BillingCycle,
} from '@/lib/polar-env';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { getAppUrl } from '@/lib/config';
import { getEnv } from '@/lib/env';
import { checkIdempotency, storeIdempotencyResult } from '@/lib/middleware/idempotency';

// ============================================================================
// Polar SDK client
// ============================================================================

/**
 * POLAR_ACCESS_TOKEN — authenticates requests to Polar REST API.
 *
 * Source: Polar Dashboard > Settings > API Keys
 * Format: "polar_at_<alphanumeric>" — server-only, never exposed to browser.
 * WHY read at module scope: constructing the client once per cold-start
 * avoids repeated env lookups. The SDK does not cache the token; it sends it
 * on every request. Rotation requires a redeployment.
 *
 * NEVER log this value (OWASP ASVS V7.1.1).
 */
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

// ============================================================================
// Zod schema
// ============================================================================

/**
 * Strict allowlist schema for the checkout POST body.
 *
 * WHY z.enum for tier (not z.string): an open z.string() allows arbitrary
 * tier values that would fall through getPolarProductId() with an empty
 * string, producing a Polar 400 with an opaque "invalid product" message.
 * z.enum rejects unknown tiers at the schema layer with a clear validation
 * error, before any API call is made.
 *
 * WHY enterprise is excluded: enterprise plans are custom deals; no self-
 * service checkout exists. Callers must use the sales flow.
 *
 * WHY seats is z.number().int() not z.string(): The body is JSON; the client
 * sends a numeric literal. Parsing a string "3" as a number silently passes
 * for valid integers but would confuse NaN detection. Keeping it numeric
 * forces the client to serialize correctly and avoids a coercion step.
 */
const TeamCheckoutBodySchema = z.object({
  team_id: z.string().uuid('team_id must be a valid UUID'),
  tier: z.enum(['team', 'business'], {
    errorMap: () => ({ message: "tier must be 'team' or 'business'" }),
  }),
  cycle: z.enum(['monthly', 'annual'], {
    errorMap: () => ({ message: "cycle must be 'monthly' or 'annual'" }),
  }),
  seats: z
    .number({ invalid_type_error: 'seats must be a number' })
    .int('seats must be an integer')
    .positive('seats must be positive'),
});

// ============================================================================
// Auth helpers — mirror the invitations/accept Bearer-token pattern
// ============================================================================

/**
 * Builds an authenticated Supabase client from either a cookie-based session
 * (web) or a Bearer token (mobile).
 *
 * WHY dual-path: mobile clients cannot set cookies. They send the Supabase
 * access_token in Authorization: Bearer. We detect the header and build a
 * cookie-free client scoped to that JWT so auth.getUser() resolves correctly
 * and RLS still applies. This pattern is canonical in this codebase — see
 * /api/invitations/accept for the authoritative reference.
 *
 * @param request - Incoming HTTP request
 * @returns Authenticated Supabase client (user-scoped, RLS active)
 */
async function buildAuthClient(request: Request) {
  const authHeader = request.headers.get('authorization');
  const hasBearerAuth = authHeader?.startsWith('Bearer ') ?? false;

  if (hasBearerAuth) {
    const accessToken = authHeader!.slice(7);
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get: () => undefined,
          set: () => {},
          remove: () => {},
        },
        global: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    );
  }

  return createClient();
}

// ============================================================================
// Route handler
// ============================================================================

/**
 * POST /api/billing/checkout
 *
 * Flow:
 *   1. Rate limit
 *   2. Parse + validate body
 *   3. Authenticate caller (cookie or Bearer)
 *   4. Verify caller is owner/admin of the team
 *   5. Re-validate seat count (never trust client)
 *   6. Resolve Polar product ID from env
 *   7. Call Polar checkouts.create()
 *   8. Write audit_log 'team_checkout_initiated'
 *   9. Return { checkout_url }
 *
 * @param request - Incoming POST request
 * @returns JSON response with checkout_url or structured error
 */
export async function POST(request: Request): Promise<Response> {
  // ── Step 1: Rate limit ────────────────────────────────────────────────────

  // WHY: Polar checkout creation has API costs. 5/min is generous for human
  // usage and prevents automated abuse (e.g. scraping product IDs via timing).
  const { allowed, retryAfter } = await rateLimit(
    request as Parameters<typeof rateLimit>[0],
    RATE_LIMITS.checkout,
    'team-checkout',
  );
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // ── Step 2: Parse + validate body ─────────────────────────────────────────

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = TeamCheckoutBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      },
      { status: 400 },
    );
  }

  const { team_id, tier, cycle, seats } = parsed.data;

  // ── Step 3: Authenticate caller ───────────────────────────────────────────

  const supabase = await buildAuthClient(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    );
  }

  // ── Step 3b: Idempotency check ────────────────────────────────────────────

  // WHY: Team checkout creates a Polar session which initiates a payment flow.
  // If the CLI retries on a transient network error, a second checkout session
  // is created for the same payment intent. The idempotency cache returns the
  // original checkout URL so the user lands on the same Polar page, not a
  // duplicate. OWASP A04:2021 replay protection.
  const ROUTE_TEAM_CHECKOUT = '/api/billing/checkout/team';
  const idemResult = await checkIdempotency(request, user.id, ROUTE_TEAM_CHECKOUT);
  if ('conflict' in idemResult) {
    return NextResponse.json({ error: 'CONFLICT', message: idemResult.message }, { status: 409 });
  }
  if (idemResult.replayed) {
    return NextResponse.json(idemResult.body, { status: idemResult.status });
  }

  // ── Step 4: Verify caller is owner/admin of the team ─────────────────────

  // WHY user-scoped client (not admin): RLS on team_members ensures the query
  // only returns rows where user_id matches the authenticated user. Using the
  // admin client here would bypass RLS and require manual user_id filtering —
  // the user-scoped client enforces it automatically.
  const { data: membership, error: membershipError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', team_id)
    .eq('user_id', user.id)
    .single();

  if (membershipError || !membership) {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'You are not a member of this team' },
      { status: 403 },
    );
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Only team owners and admins can manage billing' },
      { status: 403 },
    );
  }

  // ── Step 5: Re-validate seat count ────────────────────────────────────────

  // WHY: The page validated before rendering, but the API must validate again.
  // NEVER trust the body — a client can POST arbitrary JSON to this endpoint.
  const seatValidation = validateSeatCount(tier as BillableTier, seats);
  if (!seatValidation.ok) {
    return NextResponse.json(
      {
        error: 'INVALID_SEATS',
        message: seatValidation.reason,
        minSeats: seatValidation.minSeats,
      },
      { status: 422 },
    );
  }

  // ── Step 6: Resolve Polar product ID ─────────────────────────────────────

  // WHY: product IDs live in env vars (not source code) so test/prod Polar
  // environments are never confused. getPolarProductId() reads from process.env
  // at call time — see polar-env.ts for the complete rationale.
  const productId = getPolarProductId(tier as TeamBillingTier, cycle as BillingCycle);
  if (!productId) {
    // Missing product ID = configuration error. Never surface Polar details.
    console.error(`[team-checkout] Missing Polar product ID for ${tier}/${cycle} — check env vars`);
    return NextResponse.json(
      { error: 'UPSTREAM_ERROR', message: 'Billing configuration error. Please contact support.' },
      { status: 502 },
    );
  }

  // ── Step 7: Call Polar checkouts.create() ────────────────────────────────

  const appUrl = getAppUrl();

  let checkoutUrl: string;
  try {
    // WHY `as unknown as Parameters<typeof polar.checkouts.create>[0]`:
    //   @polar-sh/sdk v0.29.3's `CheckoutProductCreate` type does not model
    //   the `quantity` field even though the Polar REST API accepts it for
    //   per-seat products (the field is present in the wire protocol and
    //   documented in Polar's API reference). The intermediate `unknown` cast
    //   is the correct TypeScript pattern for adapter code at a third-party
    //   library boundary — we pass a valid payload that the library's type
    //   system simply hasn't modelled yet.
    //
    //   SOC2 CC7.2: This is an adapter boundary comment per CLAUDE.md code
    //   documentation standards. When the SDK is upgraded to a version that
    //   types `quantity`, remove this cast and the comment.
    const createPayload = {
      productId,
      // WHY quantity = seats: Polar per-seat products multiply quantity × unit
      // price to produce the invoice amount. Setting quantity here ensures the
      // checkout total matches the seat count the user confirmed on our page.
      quantity: seats,
      // WHY metadata: the webhook handler (Unit B) reads these fields to
      // update teams.billing_tier, billing_cycle, and seat_cap on payment.
      // If metadata is missing, the webhook cannot route the event correctly.
      metadata: {
        team_id,
        tier,
        cycle,
        seats: String(seats), // Polar metadata values must be strings
      },
      successUrl: `${appUrl}/dashboard/team/${team_id}?billing=success`,
      cancelUrl: `${appUrl}/dashboard/team/${team_id}/billing?canceled=true`,
    } as unknown as Parameters<typeof polar.checkouts.create>[0];

    const checkout = await polar.checkouts.create(createPayload);

    if (!checkout.url) {
      throw new Error('Polar returned a checkout with no URL');
    }

    checkoutUrl = checkout.url;
  } catch (err) {
    // WHY 502 (not 500): we are forwarding an upstream Polar failure. 502
    // signals "bad gateway" — the Styrby server is healthy but its upstream
    // (Polar) is not. Polar will not retry on 502 from this endpoint (unlike
    // webhooks), so 502 is purely for client observability.
    //
    // WHY only log the message (not the full error object): the full Polar
    // error response may include checkout context or API key references.
    // Logging only the message keeps secrets out of log aggregation.
    const message = err instanceof Error ? err.message : 'Unknown Polar error';
    console.error(`[team-checkout] Polar checkouts.create failed: ${message}`);
    return NextResponse.json(
      { error: 'UPSTREAM_ERROR', message: 'Payment provider unavailable. Please try again.' },
      { status: 502 },
    );
  }

  // ── Step 8: Write audit_log ───────────────────────────────────────────────

  // WHY admin client for audit_log: the audit_log table has RLS that only
  // allows service_role inserts (prevents users from forging audit entries).
  // We use the admin client ONLY for this insert — all prior reads used the
  // user-scoped client with RLS active.
  //
  // WHY warn-and-continue on audit failure: the checkout URL was successfully
  // obtained. An audit failure should not cancel the user's checkout. Ops
  // monitoring will catch repeated audit failures as a signal.
  const adminClient = createAdminClient();
  const { error: auditError } = await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: 'team_checkout_initiated',
    resource_type: 'team',
    resource_id: team_id,
    metadata: {
      tier,
      cycle,
      seats,
      // WHY NOT log checkoutUrl: Polar checkout URLs are single-use session
      // tokens. Logging them could allow a malicious log-reader to redirect
      // the payment to a different Polar account if Polar's session guard fails.
    },
  });

  if (auditError) {
    console.error('[team-checkout] Failed to write audit_log:', auditError.message);
  }

  // ── Step 9: Return checkout URL ───────────────────────────────────────────

  // WHY store before returning: ensures concurrent duplicate requests receive
  // the cached response on their next retry rather than creating a second
  // Polar checkout session.
  const responseBody = { checkout_url: checkoutUrl };
  await storeIdempotencyResult(request, user.id, ROUTE_TEAM_CHECKOUT, 200, responseBody);

  return NextResponse.json(responseBody, { status: 200 });
}
