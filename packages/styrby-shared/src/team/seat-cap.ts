/**
 * Seat-cap validator for team invitations (Phase 2.2).
 *
 * Validates whether a team has room to accept one more member before an
 * invitation is sent. Called by the `teams-invite` edge function.
 *
 * Design decisions:
 *   - Reads `teams.active_seats` (trigger-maintained counter) rather than
 *     issuing a SELECT COUNT(*) on `team_members`. This avoids a full table
 *     scan and reduces the validate→insert race window.
 *   - Race prevention is handled in the edge function via a PostgreSQL
 *     advisory lock (`pg_try_advisory_xact_lock`) keyed on the team UUID's
 *     numeric hash. The lock ensures that two concurrent invite requests for
 *     the same team cannot both pass the cap check and both insert — only the
 *     first acquires the lock; the second blocks until the first commits.
 *     WHY advisory lock over SERIALIZABLE isolation: SERIALIZABLE on the
 *     entire invite flow would conflict with concurrent reads of unrelated
 *     tables (sessions, messages) that the edge function also touches.
 *     A targeted advisory lock is narrower and has lower deadlock risk.
 *   - seat_cap = NULL → unlimited seats (Phase 2.6 Polar webhook will
 *     populate this from subscription metadata). We return ok=true with a
 *     nullCapWarning=true field so the edge function can log a structured
 *     warning without blocking the invite.
 *
 * @module team/seat-cap
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result returned by {@link validateSeatCap}.
 */
export interface SeatCapResult {
  /** True if there is capacity for another seat. */
  ok: boolean;

  /** Current trigger-maintained seat count (active members). */
  currentSeats: number;

  /**
   * The configured seat cap for this team.
   * NULL means unlimited (Phase 2.6 not yet deployed).
   */
  seatCap: number | null;

  /**
   * Present when ok=false. Contains the upgrade CTA URL.
   */
  overageInfo?: {
    /** Relative URL for the billing upgrade page. */
    upgradeCta: string;
  };

  /**
   * Present and true when seat_cap is NULL.
   * WHY: Callers (edge function) should log this as a structured warning so
   * we can audit teams operating without a cap before Phase 2.6 ships.
   */
  nullCapWarning?: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Validates whether a team has capacity for one more seat.
 *
 * Reads `teams.active_seats` and `teams.seat_cap` in a single SELECT to
 * avoid TOCTOU races between two separate queries. The advisory lock that
 * prevents concurrent double-invites is acquired in the calling edge function
 * (see `supabase/functions/teams-invite/index.ts` — `pg_try_advisory_xact_lock`
 * section) rather than here, so this function is intentionally read-only.
 *
 * @param teamId - UUID of the team to check
 * @param supabaseClient - Authenticated Supabase client (service-role in edge fn)
 * @returns Promise resolving to a {@link SeatCapResult}
 * @throws When the Supabase query fails or the team row is not found
 *
 * @example
 * const capResult = await validateSeatCap(teamId, supabase);
 * if (!capResult.ok) {
 *   return new Response(JSON.stringify({
 *     error: 'SEAT_CAP_EXCEEDED',
 *     upgradeCta: capResult.overageInfo?.upgradeCta,
 *   }), { status: 402 });
 * }
 */
export async function validateSeatCap(
  teamId: string,
  supabaseClient: SupabaseClient,
): Promise<SeatCapResult> {
  const { data: team, error } = await supabaseClient
    .from('teams')
    .select('seat_cap, active_seats')
    .eq('id', teamId)
    .single();

  if (error) {
    // WHY we re-throw rather than return ok=false: An error means we couldn't
    // determine the cap, not that the cap is exceeded. Returning ok=false would
    // block invites when the DB is temporarily unreachable, which is wrong.
    // The edge function handles the thrown error with a 500 response.
    throw new Error(error.message);
  }

  if (team === null) {
    throw new Error(`Team not found: ${teamId}`);
  }

  const currentSeats: number = team.active_seats ?? 0;
  const seatCap: number | null = team.seat_cap ?? null;

  // NULL seat_cap = unlimited. Return ok=true with warning flag.
  if (seatCap === null) {
    return {
      ok: true,
      currentSeats,
      seatCap: null,
      nullCapWarning: true,
    };
  }

  // WHY >= rather than >: active_seats is maintained by triggers that increment
  // AFTER a member row is inserted. At invite-send time, pending invitations
  // are not yet members. We compare against active_seats only (accepted seats),
  // meaning the cap check allows up to seatCap simultaneous invites to be sent
  // but only seatCap seats can be accepted. This is intentional: invites don't
  // consume seats until accepted (consistent with Stripe/Polar seat billing).
  if (currentSeats >= seatCap) {
    return {
      ok: false,
      currentSeats,
      seatCap,
      overageInfo: {
        upgradeCta: `/billing/add-seat?team=${teamId}`,
      },
    };
  }

  return {
    ok: true,
    currentSeats,
    seatCap,
  };
}
