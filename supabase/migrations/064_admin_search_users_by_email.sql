-- ============================================================================
-- Migration 062: Admin search-users-by-email RPC (H27 column-drift fix)
-- ============================================================================
--
-- WHY this migration exists:
--   The admin user-search page (dashboard/admin) previously queried
--   `profiles.email` via ILIKE for substring email search. profiles has NO
--   email column — email lives exclusively in auth.users. The query always
--   returned empty results silently. This migration adds a SECURITY DEFINER
--   RPC that performs the ILIKE search against auth.users.email directly,
--   returning matched profile rows with tier info for the admin console.
--
-- WHY SECURITY DEFINER (not SECURITY INVOKER):
--   auth.users is only accessible to the service_role by default. The function
--   runs with the privileges of its owner (the Supabase postgres superuser)
--   so it can JOIN auth.users even from a standard role. An explicit admin
--   guard (is_site_admin) inside the function body prevents non-admins from
--   using this capability. OWASP A01:2021 / SOC 2 CC6.1.
--
-- WHY search_path locked:
--   Prevents search_path hijacking attacks where an adversarial schema redefines
--   helper functions before they are invoked. SOC 2 CC6.6.
--
-- WHY trigram ILIKE on auth.users.email (not full-text):
--   Email addresses are opaque identifiers, not natural language. ILIKE with
--   % wildcards is the correct operator for substring search. Trigram indexes
--   on auth.users.email already exist in managed Supabase.
--
-- Applied: 2026-04-27 (H27 column-drift triage)
-- ============================================================================

-- ── Function ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_users_by_email_for_admin(
  p_query      text,
  p_limit      integer DEFAULT 20,
  p_offset     integer DEFAULT 0
)
RETURNS TABLE (
  id              uuid,
  email           text,
  created_at      timestamptz,
  tier            text,
  override_source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- WHY: Defense-in-depth auth gate. Even if the GRANT below is ever
  -- accidentally widened, non-admins cannot enumerate user emails.
  -- OWASP A01:2021 / SOC 2 CC6.1.
  IF NOT public.is_site_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- WHY: Reject empty/blank queries to avoid full-table scans.
  IF btrim(p_query) = '' THEN
    RETURN;
  END IF;

  -- WHY JOIN auth.users for email: profiles has no email column.
  -- WHY LEFT JOIN subscriptions: a user may have no subscription yet (free tier).
  -- WHY LIMIT/OFFSET via parameters: caller controls pagination; we never
  -- return unbounded result sets from an admin RPC.
  RETURN QUERY
    SELECT
      u.id,
      u.email::text,
      p.created_at,
      s.tier::text,
      s.override_source::text
    FROM auth.users u
    INNER JOIN public.profiles p ON p.id = u.id
    LEFT JOIN LATERAL (
      -- Most recent subscription row per user (there should only be one, but
      -- a LATERAL with LIMIT 1 is safe against duplicates).
      SELECT sub.tier, sub.override_source
      FROM public.subscriptions sub
      WHERE sub.user_id = u.id
      ORDER BY sub.updated_at DESC
      LIMIT 1
    ) s ON true
    WHERE
      u.email ILIKE '%' || p_query || '%'
      AND p.deleted_at IS NULL  -- exclude soft-deleted profiles
    ORDER BY p.created_at DESC
    LIMIT  p_limit
    OFFSET p_offset;
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────

-- WHY service_role only: Only the server-side admin client (createAdminClient)
-- may call this. The anon and authenticated roles must not be able to enumerate
-- emails even indirectly. SOC 2 CC6.1.
REVOKE ALL ON FUNCTION public.search_users_by_email_for_admin(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_users_by_email_for_admin(text, integer, integer)
  TO service_role;

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON FUNCTION public.search_users_by_email_for_admin IS
  'Admin-only RPC: search users by partial email match (ILIKE). '
  'Bridges auth.users.email (not on profiles) to the admin console. '
  'H27 column-drift fix. Migration 062.';
