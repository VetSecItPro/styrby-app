/**
 * Seat Count Management API Route
 *
 * GET  /api/billing/seats  — Returns current seat count + proration preview
 *   for the requested new_seat_count. Use this to render a consent screen
 *   before the user commits to the PATCH.
 *
 * PATCH /api/billing/seats — Applies the seat count change to the team's
 *   Polar subscription and updates teams.active_seats. The seat_cap column
 *   is NOT updated here — it is authoritative only after the Polar webhook
 *   fires (Unit B), which runs asynchronously.
 *
 * Handles the "add seats mid-cycle" flow WITHOUT going back through full
 * checkout. The team must already have a Polar subscription
 * (teams.polar_subscription_id must be non-null).
 *
 * @auth Required - Supabase Auth JWT via cookie (web) OR Authorization: Bearer
 *   <access_token> header (mobile). Same dual-path pattern as
 *   /api/invitations/accept and /api/billing/checkout/team.
 *
 * @rateLimit 30 requests per minute (RATE_LIMITS.standard)
 *
 * GET query params:
 *   team_id:        UUID
 *   new_seat_count: integer
 *
 * PATCH body (JSON):
 *   { team_id: string, new_seat_count: integer }
 *
 * @returns GET  200 { current_seats, new_seats, proration_cents, tier, cycle }
 * @returns PATCH 200 { success: true, active_seats: number, proration_cents: number }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 404 { error: 'NO_SUBSCRIPTION', message: string }
 * @error 409 { error: 'DOWNGRADE_BLOCKED', message: string, details: object }
 * @error 422 { error: 'INVALID_SEATS', message: string, minSeats: number }
 * @error 502 { error: 'UPSTREAM_ERROR', message: string }
 *
 * Security:
 *   - PATCH is the confirmed step — the GET consent screen is informational only.
 *   - Downgrade guard (409 DOWNGRADE_BLOCKED) fires BEFORE calling Polar's API.
 *     This prevents Polar from accepting a seat reduction that would leave
 *     active members without seats (billing integrity + user trust invariant).
 *   - All Polar subscription fields are read from Polar API, not the DB, to
 *     avoid stale data (the webhook may not have synced yet).
 *   - POLAR_ACCESS_TOKEN never logged (OWASP ASVS V7.1.1).
 *   - service_role ONLY for audit_log inserts (after auth + authz pass).
 *
 * SOC2 CC6.1: Admin-only action enforced before any state change.
 * SOC2 CC7.2: Both DOWNGRADE_BLOCKED and successful seat changes are audited.
 *
 * @module api/billing/seats/route
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { createServerClient } from '@supabase/ssr';
import { Polar } from '@polar-sh/sdk';
import {
  validateSeatCount,
  calculateProrationCents,
  type BillableTier,
} from '@styrby/shared/billing';
import type { TeamBillingTier, BillingCycle } from '@/lib/polar-env';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Polar client
// ============================================================================

/**
 * POLAR_ACCESS_TOKEN — server-side API key for Polar REST operations.
 *
 * WHY module-scope: single client instance per cold-start. The SDK sends
 * the token on every request; constructing per-request would create GC
 * pressure with no benefit.
 *
 * NEVER log this value (OWASP ASVS V7.1.1).
 */
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
});

// ============================================================================
// Zod schemas
// ============================================================================

/**
 * PATCH body schema.
 *
 * WHY new_seat_count as z.number().int().positive(): negative seats and
 * fractional seats are nonsensical. z.positive() rejects 0 as well — a
 * team cannot have zero seats (the minimum is tier-specific and enforced
 * by validateSeatCount, but 0 is universally invalid).
 */
const SeatsPatchBodySchema = z.object({
  team_id: z.string().uuid('team_id must be a valid UUID'),
  new_seat_count: z
    .number({ invalid_type_error: 'new_seat_count must be a number' })
    .int('new_seat_count must be an integer')
    .positive('new_seat_count must be a positive integer'),
});

/**
 * GET query param schema.
 *
 * WHY z.coerce.number(): query params are always strings; coerce converts
 * "5" → 5 before the int/positive checks run. Without coerce, the
 * z.number() check would always fail for query params.
 */
const SeatsGetQuerySchema = z.object({
  team_id: z.string().uuid('team_id must be a valid UUID'),
  new_seat_count: z.coerce
    .number({ invalid_type_error: 'new_seat_count must be a number' })
    .int('new_seat_count must be an integer')
    .positive('new_seat_count must be a positive integer'),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Row shape fetched from the teams table.
 *
 * WHY partial (not full table): we only select what we need to minimise
 * data transfer and avoid accidentally exposing sensitive columns in error
 * paths (e.g., internal Polar keys if they were ever added to teams).
 */
interface TeamBillingRow {
  polar_subscription_id: string | null;
  billing_tier: TeamBillingTier | null;
  billing_cycle: BillingCycle | null;
  seat_cap: number | null;
  active_seats: number | null;
}

/**
 * Polar subscription fields we actually read from the API response.
 *
 * WHY `unknown` cast in fetchPolarSubscription: the @polar-sh/sdk v0.29.3
 * `Subscription` type does not expose `quantity` as a typed field (it is
 * present in the JSON payload but not modelled in the TypeScript type).
 * We cast through `unknown` to our local interface which declares only
 * the fields we consume, keeping the rest of the codebase type-safe.
 *
 * WHY currentPeriodStart / currentPeriodEnd are `Date | string | null`:
 *   The SDK models these as `Date` but serialisation can return strings.
 *   Wrapping with `new Date(...)` in computeCycleDays handles both forms.
 */
interface PolarSubscription {
  id: string;
  /** Seat count — present in JSON but not typed in SDK v0.29.3 */
  quantity: number | null;
  currentPeriodStart: Date | string | null;
  currentPeriodEnd: Date | string | null;
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Builds an authenticated Supabase client from cookie or Bearer token.
 *
 * WHY: Same dual-path pattern as /api/invitations/accept. Mobile clients
 * send Authorization: Bearer <token> (no cookies). See that route for the
 * authoritative comment explaining the security rationale.
 *
 * @param request - Incoming HTTP request
 * @returns User-scoped Supabase client with RLS active
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

/**
 * Authenticates the caller and verifies team admin membership.
 *
 * WHY a shared helper: both GET and PATCH need auth + team admin check.
 * Centralising avoids copy-paste drift where one handler forgets a step.
 *
 * @param request - Incoming HTTP request
 * @param teamId - The team UUID to check membership for
 * @returns { user, supabase } on success, or { error: NextResponse } on failure
 */
/**
 * Success result type for authAndCheckTeamAdmin.
 */
type AuthSuccess = {
  user: { id: string; email?: string | null };
  supabase: Awaited<ReturnType<typeof buildAuthClient>>;
};

/**
 * Result type for authAndCheckTeamAdmin — discriminated union on 'error'.
 *
 * WHY `Response` (not `NextResponse`): NextResponse is a subclass of Response.
 * Using `Response` in the union avoids TypeScript's structural compatibility
 * errors when the return type is inferred from branches that produce
 * `NextResponse<{error: string; ...}>` (a narrower generic) while the
 * caller's `error` property is typed as the broader `NextResponse<unknown>`.
 * Widening to `Response` — the common supertype — satisfies both sides.
 */
type AuthResult = { error: Response } | AuthSuccess;

async function authAndCheckTeamAdmin(request: Request, teamId: string): Promise<AuthResult> {
  const supabase = await buildAuthClient(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      error: NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      ),
    };
  }

  const { data: membership, error: membershipError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (membershipError || !membership) {
    return {
      error: NextResponse.json(
        { error: 'FORBIDDEN', message: 'You are not a member of this team' },
        { status: 403 },
      ),
    };
  }

  if ((membership as { role: string }).role !== 'owner' && (membership as { role: string }).role !== 'admin') {
    return {
      error: NextResponse.json(
        { error: 'FORBIDDEN', message: 'Only team owners and admins can manage seats' },
        { status: 403 },
      ),
    };
  }

  return { user, supabase };
}

/**
 * Fetches the team's billing row from Supabase.
 *
 * WHY user-scoped client: team RLS only returns rows the user belongs to.
 * We already verified admin membership above, so the row will be visible.
 *
 * @param supabase - Authenticated user-scoped Supabase client
 * @param teamId - UUID of the team
 * @returns { team } on success, or { error: NextResponse } if not found
 */
async function fetchTeamBillingRow(
  supabase: Awaited<ReturnType<typeof buildAuthClient>>,
  teamId: string,
): Promise<{ team: TeamBillingRow } | { error: Response }> {
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select(
      'polar_subscription_id, billing_tier, billing_cycle, seat_cap, active_seats',
    )
    .eq('id', teamId)
    .single() as { data: TeamBillingRow | null; error: unknown };

  if (teamError || !team || !team.polar_subscription_id) {
    return {
      error: NextResponse.json(
        {
          error: 'NO_SUBSCRIPTION',
          message:
            'This team does not have an active subscription. ' +
            'Complete checkout before modifying seat count.',
        },
        { status: 404 },
      ),
    };
  }

  return { team };
}

/**
 * Fetches subscription details from Polar API.
 *
 * WHY live Polar fetch (not DB): the DB subscription state may be stale if
 * a recent webhook has not yet been processed. Polar's API always reflects
 * the current billing cycle and quantity. Using a stale quantity would cause
 * an incorrect proration calculation.
 *
 * @param subscriptionId - The Polar subscription UUID
 * @returns { subscription } on success, or { error: NextResponse } on Polar failure
 */
async function fetchPolarSubscription(
  subscriptionId: string,
): Promise<{ subscription: PolarSubscription } | { error: Response }> {
  try {
    const sub = await polar.subscriptions.get({ id: subscriptionId });
    // WHY double cast (as unknown as PolarSubscription): the Polar SDK v0.29.3
    // `Subscription` type does not include `quantity` in its TypeScript model,
    // even though the actual JSON payload contains it. We use our local
    // `PolarSubscription` interface which declares only the fields we read.
    // The intermediate `unknown` cast is required by TypeScript when the source
    // and target types have no documented overlap.
    return { subscription: sub as unknown as PolarSubscription };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Polar error';
    console.error(`[billing/seats] Polar subscriptions.get failed: ${message}`);
    return {
      error: NextResponse.json(
        { error: 'UPSTREAM_ERROR', message: 'Payment provider unavailable. Please try again.' },
        { status: 502 },
      ),
    };
  }
}

/**
 * Computes elapsed and cycle-length in integer days from Polar subscription dates.
 *
 * WHY Math.round (not Math.floor): Polar timestamps include time components.
 * If the current period started at 14:00 and it is now 13:59 on day 15, a
 * pure floor() would yield 14 (undercount by 1). Round() gives the nearest
 * integer day, which is more accurate for proration. calculateProrationCents
 * always floors the final cents result, so the rounding here never inflates
 * the charge.
 *
 * WHY integer validation on the result: calculateProrationCents rejects
 * non-integers. If rounding somehow yields a non-integer (floating-point
 * representation of a whole number), we clamp with Math.round() which always
 * produces an integer for reasonable inputs.
 *
 * WHY null/undefined guard on timestamps: Polar can return null timestamps for
 * paused subscriptions or when the SDK type diverges from the actual REST
 * response (e.g., a version bump that adds a new subscription state). The Date
 * constructor on null returns epoch (0), producing a daysElapsed of ~20,000+
 * days. The Date constructor on undefined returns NaN, which propagates through
 * Math.max(0, NaN) → NaN → calculateProrationCents → RangeError → uncaught
 * Next.js 500. We fall back to a safe default (day 0 of a 30-day cycle = zero
 * proration) which is the correct conservative behavior for an ambiguous state.
 *
 * @param subscription - The Polar subscription object
 * @returns { daysElapsed, daysInCycle } — both non-negative integers
 */
function computeCycleDays(subscription: PolarSubscription): {
  daysElapsed: number;
  daysInCycle: number;
} {
  const MS_PER_DAY = 86_400_000;
  const startRaw = subscription.currentPeriodStart;
  const endRaw = subscription.currentPeriodEnd;

  // WHY guard: Polar returns null timestamps for paused subscriptions or on
  // SDK/REST version drift. Fall back to safe defaults — day 0 of a 30-day
  // cycle yields proration_cents = 0, the correct conservative result for an
  // ambiguous subscription state.
  if (!startRaw || !endRaw) {
    console.warn('[billing/seats] Polar subscription missing timestamps, using safe defaults', {
      subscription_id: subscription.id,
    });
    return { daysElapsed: 0, daysInCycle: 30 };
  }

  const startMs = new Date(startRaw).getTime();
  const endMs = new Date(endRaw).getTime();

  // WHY isFinite check: new Date(malformed_string).getTime() returns NaN, which
  // propagates silently through Math.max and into calculateProrationCents where
  // it triggers a RangeError. endMs <= startMs catches inverted ranges (e.g.,
  // a subscription that reports its end before its start due to a Polar bug).
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    console.warn('[billing/seats] Polar subscription timestamps invalid, using safe defaults', {
      subscription_id: subscription.id,
      start_raw: startRaw,
      end_raw: endRaw,
    });
    return { daysElapsed: 0, daysInCycle: 30 };
  }

  const nowMs = Date.now();

  // WHY Math.max(0, ...): if clock skew causes now < periodStart,
  // daysElapsed would be negative — clamp to 0 to keep it valid.
  const daysElapsed = Math.max(0, Math.round((nowMs - startMs) / MS_PER_DAY));
  const daysInCycle = Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY));

  return { daysElapsed, daysInCycle };
}

// ============================================================================
// GET — Proration preview / consent screen data
// ============================================================================

/**
 * GET /api/billing/seats
 *
 * Returns a proration preview for the proposed seat count change.
 * Use this to render the consent screen before the user commits to PATCH.
 *
 * WHY a separate GET: the spec requires a consent screen. The client
 * shows the user exactly what they will be charged before submitting.
 * The PATCH is the "confirmed" step — it runs unconditionally for the
 * authenticated admin who calls it.
 *
 * @param request - Incoming GET request with query params team_id + new_seat_count
 * @returns 200 { current_seats, new_seats, proration_cents, tier, cycle }
 */
export async function GET(request: Request): Promise<Response> {
  const { allowed, retryAfter } = await rateLimit(
    request as Parameters<typeof rateLimit>[0],
    RATE_LIMITS.standard,
    'billing-seats-get',
  );
  if (!allowed) return rateLimitResponse(retryAfter!);

  // Parse query params
  const url = new URL(request.url);
  const rawQuery = Object.fromEntries(url.searchParams.entries());
  const parsed = SeatsGetQuerySchema.safeParse(rawQuery);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid query params' },
      { status: 400 },
    );
  }

  const { team_id, new_seat_count } = parsed.data;

  // Auth + admin check
  const authResult = await authAndCheckTeamAdmin(request, team_id);
  if ('error' in authResult) return authResult.error;
  const { supabase } = authResult;

  // Fetch team billing row
  const teamResult = await fetchTeamBillingRow(supabase, team_id);
  if ('error' in teamResult) return teamResult.error;
  const { team } = teamResult;

  const tier = team.billing_tier!;
  const cycle = team.billing_cycle!;

  // Validate new seat count
  const seatValidation = validateSeatCount(tier as BillableTier, new_seat_count);
  if (!seatValidation.ok) {
    return NextResponse.json(
      { error: 'INVALID_SEATS', message: seatValidation.reason, minSeats: seatValidation.minSeats },
      { status: 422 },
    );
  }

  // Fetch live Polar subscription
  const subResult = await fetchPolarSubscription(team.polar_subscription_id!);
  if ('error' in subResult) return subResult.error;
  const { subscription } = subResult;

  // WHY quantity ?? seat_cap ?? 1: subscription.quantity is null for paused
  // subscriptions and also when the Polar SDK type diverges from the actual
  // REST response (SDK type drift across minor versions). seat_cap is the DB
  // snapshot of the last webhook-confirmed seat count — the next-best source
  // when the live API returns null. The final fallback of 1 prevents a NaN
  // proration in the extreme case where both sources are missing, though in
  // practice a team cannot exist without at least the minimum seat count.
  const oldSeats = subscription.quantity ?? team.seat_cap ?? 1;
  const { daysElapsed, daysInCycle } = computeCycleDays(subscription);

  // Compute proration preview (0 for downgrades — Polar issues a credit)
  const prorationCents =
    new_seat_count > oldSeats
      ? calculateProrationCents({
          oldSeats,
          newSeats: new_seat_count,
          tier: tier as BillableTier,
          daysElapsed,
          daysInCycle,
        })
      : 0;

  return NextResponse.json({
    current_seats: oldSeats,
    new_seats: new_seat_count,
    proration_cents: prorationCents,
    tier,
    cycle,
  });
}

// ============================================================================
// PATCH — Apply confirmed seat count change
// ============================================================================

/**
 * PATCH /api/billing/seats
 *
 * Applies the seat count change. This is the confirmed step — the client
 * should have shown the proration preview (GET) and received user consent
 * before calling this endpoint.
 *
 * Flow:
 *   1. Rate limit
 *   2. Parse + validate body
 *   3. Auth + team admin check
 *   4. Fetch team billing row (must have polar_subscription_id)
 *   5. Re-validate new seat count (validateSeatCount)
 *   6. DOWNGRADE GUARD — reject if new_seat_count < active team members (409)
 *   7. Fetch live Polar subscription for current quantity + cycle dates
 *   8. Compute proration (for upgrade) via calculateProrationCents
 *   9. Call Polar subscriptions.update() to apply new quantity
 *  10. UPDATE teams.active_seats (transient — webhook will sync seat_cap)
 *  11. Write audit_log ('team_seat_count_increased' or 'team_downgrade_blocked')
 *  12. Return { success, active_seats, proration_cents }
 *
 * @param request - Incoming PATCH request
 * @returns JSON response
 */
export async function PATCH(request: Request): Promise<Response> {
  // ── Step 1: Rate limit ────────────────────────────────────────────────────

  const { allowed, retryAfter } = await rateLimit(
    request as Parameters<typeof rateLimit>[0],
    RATE_LIMITS.standard,
    'billing-seats-patch',
  );
  if (!allowed) return rateLimitResponse(retryAfter!);

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

  const parsed = SeatsPatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid request body' },
      { status: 400 },
    );
  }

  const { team_id, new_seat_count } = parsed.data;

  // ── Step 3: Auth + team admin check ──────────────────────────────────────

  const authResult = await authAndCheckTeamAdmin(request, team_id);
  if ('error' in authResult) return authResult.error;
  const { user, supabase } = authResult;

  // ── Step 4: Fetch team billing row ────────────────────────────────────────

  const teamResult = await fetchTeamBillingRow(supabase, team_id);
  if ('error' in teamResult) return teamResult.error;
  const { team } = teamResult;

  const tier = team.billing_tier!;
  const cycle = team.billing_cycle!;

  // ── Step 5: Re-validate seat count ────────────────────────────────────────

  // WHY: NEVER trust the body — validateSeatCount checks tier minimums and
  // integer/non-negative constraints. A client bypassing the consent screen
  // could send seats=0 or seats=1 (below team minimum of 3).
  const seatValidation = validateSeatCount(tier as BillableTier, new_seat_count);
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

  // ── Step 6: DOWNGRADE GUARD ───────────────────────────────────────────────
  //
  // WHY this guard must fire BEFORE calling Polar's API:
  //   If we call Polar first, Polar accepts the quantity reduction (it has
  //   no knowledge of how many active users the team has). We would then be
  //   stuck with a billing plan for 5 seats when 8 members are active — an
  //   inconsistent state with no automatic recovery path. The guard prevents
  //   this by rejecting at the API layer, server-side, before any Polar call.
  //
  // WHY count from team_members (not seat_cap or active_seats column):
  //   team_members is the authoritative source for who currently has access.
  //   seat_cap reflects the billed quantity; active_seats is a transient cache.
  //   Both can lag real membership if invitations were accepted after the last
  //   webhook sync. Querying team_members directly is always accurate.
  //
  // WHY { count: 'exact', head: true }: most efficient Supabase count query —
  //   returns only the count, not rows, minimising data transfer.

  const { count: activeMembers, error: countError } = await supabase
    .from('team_members')
    .select('*', { count: 'exact', head: true })
    .eq('team_id', team_id);

  if (countError) {
    console.error('[billing/seats] Failed to count team members:', countError.message);
    return NextResponse.json(
      { error: 'UPSTREAM_ERROR', message: 'Failed to verify team membership. Please try again.' },
      { status: 502 },
    );
  }

  const memberCount = activeMembers ?? 0;

  if (new_seat_count < memberCount) {
    // Write audit_log BEFORE returning — this is an attempted action worth tracking.
    // WHY: an admin repeatedly attempting to reduce below member count is a signal
    // that they may have forgotten to remove members first. Auditing helps ops
    // identify teams that need offboarding support.
    const adminClient = createAdminClient();
    await adminClient.from('audit_log').insert({
      user_id: user.id,
      action: 'team_downgrade_blocked',
      resource_type: 'team',
      resource_id: team_id,
      metadata: {
        current_members: memberCount,
        requested_seats: new_seat_count,
        blocked_delta: memberCount - new_seat_count,
        tier,
        cycle,
      },
    });

    return NextResponse.json(
      {
        error: 'DOWNGRADE_BLOCKED',
        message: `Cannot reduce seats below current member count.`,
        details: {
          current_members: memberCount,
          requested_seats: new_seat_count,
          action_required: `Remove at least ${memberCount - new_seat_count} member(s) first`,
        },
      },
      { status: 409 },
    );
  }

  // ── Step 7: Fetch live Polar subscription ─────────────────────────────────

  const subResult = await fetchPolarSubscription(team.polar_subscription_id!);
  if ('error' in subResult) return subResult.error;
  const { subscription } = subResult;

  // WHY quantity ?? seat_cap ?? 1: subscription.quantity is null for paused
  // subscriptions and also when the Polar SDK type diverges from the actual
  // REST response (SDK type drift across minor versions). seat_cap is the DB
  // snapshot of the last webhook-confirmed seat count — the next-best source
  // when the live API returns null. The final fallback of 1 prevents a NaN
  // proration in the extreme case where both sources are missing, though in
  // practice a team cannot exist without at least the minimum seat count.
  const oldSeats = subscription.quantity ?? team.seat_cap ?? 1;
  const { daysElapsed, daysInCycle } = computeCycleDays(subscription);

  // ── Step 8: Compute proration ─────────────────────────────────────────────

  // WHY only for upgrades: downgrades (new < old) produce a Polar credit, not
  // a charge. Polar handles credit issuance internally; we do not compute or
  // issue credits ourselves — that is Polar's billing engine responsibility.
  // calculateProrationCents would return a negative number for downgrades if
  // called — we skip the call entirely to avoid any ambiguity.
  const prorationCents =
    new_seat_count > oldSeats
      ? calculateProrationCents({
          oldSeats,
          newSeats: new_seat_count,
          tier: tier as BillableTier,
          daysElapsed,
          daysInCycle,
        })
      : 0;

  // ── Step 9: Update Polar subscription quantity ────────────────────────────

  // WHY no row-level lock: two concurrent upgrade requests from the same admin
  // could both pass the downgrade guard and both call Polar's subscriptions.update.
  // Polar processes them sequentially, last-writer-wins on quantity. The resulting
  // seat_cap will reflect the last successful update, which may not match the
  // admin's final intent but is not a safety issue — the Unit B webhook handler
  // will reconcile teams.seat_cap with Polar's canonical state within seconds.
  // A proper fix would use a per-team advisory lock (see public.acquire_team_invite_lock
  // pattern from migration 030), tracked as Phase 2.6b.
  try {
    await polar.subscriptions.update({
      id: team.polar_subscription_id!,
      subscriptionUpdate: {
        // WHY quantity (not seats): Polar's per-seat product uses `quantity`
        // to represent seat count. The billing engine multiplies quantity ×
        // unit price to compute the invoice amount.
        // @ts-expect-error — Polar SDK type for quantity update varies across versions
        quantity: new_seat_count,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Polar error';
    console.error(`[billing/seats] Polar subscriptions.update failed: ${message}`);
    return NextResponse.json(
      { error: 'UPSTREAM_ERROR', message: 'Payment provider unavailable. Please try again.' },
      { status: 502 },
    );
  }

  // ── Step 10: Update teams.active_seats (transient cache) ─────────────────

  // WHY active_seats (not seat_cap): seat_cap is the authoritative billed
  // count, updated ONLY by the Unit B webhook handler after Polar confirms the
  // subscription change. active_seats is a transient cache that enables the UI
  // to reflect the change optimistically before the webhook arrives.
  //
  // WHY warn-and-continue on DB failure: the Polar subscription was already
  // updated. Failing here does not undo the Polar change. The webhook will
  // sync seat_cap correctly. The transient cache miss is acceptable.
  const { error: updateError } = await supabase
    .from('teams')
    .update({ active_seats: new_seat_count })
    .eq('id', team_id);

  if (updateError) {
    console.error('[billing/seats] Failed to update active_seats:', updateError.message);
    // WHY continue (not return error): Polar update succeeded. The webhook
    // will eventually sync seat_cap. A transient active_seats miss is
    // preferable to surfacing an error that implies the seat change failed.
  }

  // ── Step 11: Write audit_log ──────────────────────────────────────────────

  // WHY direction-aware action: the audit enum has both 'team_seat_count_increased'
  // and 'team_seat_count_decreased' (added in migration 031). Using the wrong
  // action for a downgrade makes compliance queries misleading — an ops engineer
  // searching for decreases would miss the event. The delta field is negative for
  // decreases, giving an unambiguous signal in either direction.
  const auditAction =
    new_seat_count > oldSeats ? 'team_seat_count_increased' : 'team_seat_count_decreased';

  const adminClient = createAdminClient();
  const { error: auditError } = await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: auditAction,
    resource_type: 'team',
    resource_id: team_id,
    metadata: {
      old_seat_count: oldSeats,
      new_seat_count,
      // WHY negative delta for decreases: makes it unambiguous at query time
      // without needing to compare old vs new fields. Positive = upgrade, negative = downgrade.
      delta: new_seat_count - oldSeats,
      // WHY include proration_cents in audit: allows ops to reconcile billing
      // discrepancies against the expected proration amount without querying Polar.
      // proration_cents is 0 for decreases per calculateProrationCents contract.
      proration_cents: prorationCents,
      days_elapsed: daysElapsed,
      days_in_cycle: daysInCycle,
      tier,
      cycle,
    },
  });

  if (auditError) {
    console.error('[billing/seats] Failed to write audit_log:', auditError.message);
  }

  // ── Step 12: Return success ───────────────────────────────────────────────

  return NextResponse.json({
    success: true,
    active_seats: new_seat_count,
    proration_cents: prorationCents,
  });
}
