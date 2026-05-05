-- Migration 037: Atomic seat-change lock + member-count RPC
--
-- Closes WAVE-E-001: PATCH /api/billing/seats counts team_members and then
-- tells Polar to set the new seat quantity. Without serialization, an
-- in-flight invitation accept can insert a new team_members row between the
-- count read and the Polar update — undercounting by 1 (or more) and leaving
-- the team with fewer paid seats than active members.
--
-- WHY a single RPC (not separate `acquire_lock` + `count`):
--   pg_try_advisory_xact_lock releases at TRANSACTION end. PostgREST opens a
--   new transaction per RPC call, so an `acquire_lock` RPC followed by a
--   separate `count` RPC would release the lock between them — the race
--   reopens. Wrapping lock + count in ONE function call keeps both inside
--   the same transaction so the lock is held for the duration of the count.
--
-- WHY we still need API-side serialization with the Polar update:
--   The lock CANNOT span the Polar HTTP call — that's a network round-trip
--   outside Postgres. The mitigation is layered:
--     (1) This RPC serializes the count read against any other holder of
--         the same lock id (concurrent invite-accepts that use
--         acquire_team_invite_lock with the same hash, OR a parallel PATCH
--         on the same team).
--     (2) The teams-invite edge function already calls
--         acquire_team_invite_lock(teamIdHash) before its seat-cap check
--         (migration 030, line 502 of supabase/functions/teams-invite/index.ts).
--         Both paths must use the SAME lock id (derived from team_id) so they
--         serialize against each other.
--     (3) The Polar webhook (Unit B) reconciles teams.seat_cap with Polar's
--         canonical state asynchronously — even if a transient skew slips
--         through, it converges.
--
-- WHY return both `lock_acquired` and `member_count`:
--   The caller needs to distinguish "lock contended → retry" from
--   "lock held → here's the authoritative count." Returning a row with both
--   columns lets the caller branch on lock_acquired without a second RPC.
--
-- @security WAVE-E-001 (race condition between count and seat update)
-- @security SOC 2 CC7.1 (System Operations — change management)
-- @ref supabase/migrations/030_team_invitation_flow.sql (sibling lock RPC)

CREATE OR REPLACE FUNCTION public.count_team_members_with_seat_lock(
  p_team_id uuid,
  p_team_lock_key bigint
)
RETURNS TABLE (
  lock_acquired boolean,
  member_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_acquired boolean;
  v_count bigint;
BEGIN
  -- WHY pg_try_advisory_xact_lock (not pg_advisory_xact_lock):
  --   Non-blocking. Returns false immediately on contention so the API can
  --   return 409 to the client and the client can retry, rather than holding
  --   a request-handler thread waiting indefinitely for a lock that may
  --   belong to a slow Polar call.
  v_acquired := pg_try_advisory_xact_lock(p_team_lock_key);

  IF NOT v_acquired THEN
    -- Return immediately with count = 0; caller MUST check lock_acquired
    -- before trusting member_count.
    RETURN QUERY SELECT false, 0::bigint;
    RETURN;
  END IF;

  -- Lock held — count is authoritative for the duration of this transaction.
  -- WHY count(*): we want the cardinality of the team_members rows for this
  -- team_id. The PATCH endpoint compares this to the requested new_seat_count
  -- to enforce the downgrade guard.
  SELECT count(*) INTO v_count
  FROM public.team_members
  WHERE team_id = p_team_id;

  RETURN QUERY SELECT true, v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_team_members_with_seat_lock(uuid, bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.count_team_members_with_seat_lock IS
  'WAVE-E-001 mitigation: atomically acquires the per-team advisory lock and '
  'returns the team_members count in the same transaction. Used by '
  'PATCH /api/billing/seats to prevent invitation-accept races from '
  'undercounting members during seat downgrades.';
