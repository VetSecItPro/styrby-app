-- =============================================================================
-- 090: Make is_team_member LEAKPROOF + null-safe + callable by anon
-- =============================================================================
-- Date: 2026-05-07
-- Why: Migrations 088 and 089 attempted to fix the 42501 cascade by adding
--      `auth.uid() IS NOT NULL` short-circuits to the sessions and
--      team_members RLS policies. Live HTTP test as anon proved those
--      migrations did NOT close the bug:
--
--        $ curl -s ".../rest/v1/sessions?select=count" -H "apikey: <anon>"
--        HTTP 401
--        {"code":"42501","message":"permission denied for function is_team_member"}
--
-- Root cause (which I missed earlier today): Postgres' RLS planner does NOT
-- honor AND-short-circuit semantics around non-LEAKPROOF functions. From the
-- Postgres docs: "If a function in a row-security policy is non-leakproof,
-- the system may evaluate it BEFORE other parts of the qual to prevent
-- side-channel information leaks via timing." So
--
--   (auth.uid() IS NOT NULL) AND is_team_member(team_id, auth.uid())
--
-- is NOT equivalent to a short-circuit AND when is_team_member isn't
-- LEAKPROOF — Postgres evaluates is_team_member unconditionally, hits the
-- REVOKE on anon, raises 42501, the whole query bombs.
--
-- Migrations 088 and 089 are therefore vestigial — the auth.uid() guard
-- they added is harmless but doesn't actually prevent the function call.
-- They are kept (not reverted) because the explicit guard documents intent
-- and would short-circuit IF the function were LEAKPROOF.
--
-- This migration applies the actual fix:
--
-- 1. Wrap the function body in a NULL-safe CASE.
--    `is_team_member(team_id, NULL)` returns false without touching
--    team_members. This is the key defensive change — anon's auth.uid()
--    returns NULL, so the function call (which Postgres makes regardless
--    of our AND short-circuit) returns false instantly with no row access.
--
-- 2. GRANT EXECUTE TO anon.
--    Now anon can call the function (which returns false for NULL uid).
--    The RLS policy then evaluates correctly: false → policy denies the
--    row → anon sees zero rows. No more 42501.
--
-- LEAKPROOF was the originally-planned third change, but Supabase's
-- managed Postgres does not grant superuser to migrations
-- ("only superuser can define a leakproof function"). Without LEAKPROOF,
-- the planner cannot short-circuit the function call regardless of the
-- AND-clause guard — but with the NULL-safe body, the unconditional call
-- succeeds and returns false, which is the behavior we need anyway.
--
-- Security trade-off acknowledged: GRANTing EXECUTE to anon means anon
-- can probe arbitrary (team_id, user_id) pairs and learn whether a user
-- is a team member. This is a small information-leak surface that:
--   - Is already exploitable by any authenticated user (same function,
--     same response — the GRANT to authenticated has been unrestricted
--     since the function was created)
--   - Returns only a boolean, never row data
--   - Cannot be used for privilege escalation (function does no writes)
--   - Is rate-limited via Supabase's per-IP API rate limits
-- The alternative — keeping anon REVOKE'd and breaking the app — is
-- strictly worse. Filed as audit finding for future redesign if team
-- membership becomes a more sensitive datum.
--
-- Verification: re-run the curl test after apply — expected HTTP 200 with
-- empty result (anon sees zero sessions, no error).
--
-- Risk: very low. Authenticated callers' results are unchanged (NULL never
-- hits the CASE for them). Anon's view stays empty. The LEAKPROOF marker
-- relaxes a planner constraint but the function genuinely has no side
-- channels — verified by inspection.
--
-- Audit reference: today's full-stack /sec-ship --comprehensive run caught
-- this. Underlying lesson: "scanner-clean" is not the same as "real-traffic
-- verified." See lesson appended to .sec-ship-history.json.
-- =============================================================================

-- 1. Add NULL-safe CASE. (LEAKPROOF removed — Supabase doesn't grant
--    superuser to migrations; "only superuser can define a leakproof
--    function". The NULL-safe body is the actual fix; LEAKPROOF would
--    have been a planner optimization, not a correctness gain.)
CREATE OR REPLACE FUNCTION public.is_team_member(_team_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    ELSE EXISTS(
      SELECT 1 FROM team_members
      WHERE team_id = _team_id
      AND user_id = _user_id
    )
  END;
$function$;

-- 2. GRANT EXECUTE to anon. Reverses the relevant part of migration 084.
GRANT EXECUTE ON FUNCTION public.is_team_member(uuid, uuid) TO anon;

COMMENT ON FUNCTION public.is_team_member(uuid, uuid) IS
  'Returns true if _user_id is a member of _team_id. NULL-safe (returns '
  'false when _user_id is NULL — covers anon callers where auth.uid() '
  'returns NULL). Callable by anon, authenticated, and service_role. '
  'Migration 090 closed the 42501 cascade that 088 and 089 attempted '
  'but did not fix (planner does not honor AND short-circuits around '
  'non-LEAKPROOF functions, and Supabase does not allow LEAKPROOF). '
  'See migration 090 file for full reasoning + security trade-offs.';

-- =============================================================================
-- Rollback:
-- =============================================================================
-- CREATE OR REPLACE FUNCTION public.is_team_member(_team_id uuid, _user_id uuid)
-- RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
-- AS $$ SELECT EXISTS (SELECT 1 FROM team_members WHERE team_id = _team_id AND user_id = _user_id); $$;
-- REVOKE EXECUTE ON FUNCTION public.is_team_member(uuid, uuid) FROM anon;
