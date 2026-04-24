-- Admin email resolver.
--
-- WHY: T5 RecentAuditCard and T7 audit page need to display actor/target
-- emails alongside audit rows. Emails live in auth.users (Supabase's
-- managed auth schema), not in public.profiles. Without this function,
-- the previously-written queries against `profiles.email` silently fail
-- in production (column does not exist) — tests passed because they
-- mocked the response. This function provides a SECURITY DEFINER
-- admin-gated bridge from public -> auth schema for email lookup.
--
-- Governing: SOC2 CC6.1 (authorization), CC7.2 (audit-log completeness
-- depends on displaying actor identity to the admin viewer).

CREATE OR REPLACE FUNCTION public.resolve_user_emails_for_admin(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- WHY: Defense-in-depth auth gate. Even if the GRANT below is ever accidentally
  -- widened, non-admins cannot resolve emails via this function. OWASP A01:2021.
  IF NOT public.is_site_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- WHY ANY(p_user_ids) vs IN: ANY() works cleanly with PG arrays passed via
  -- the Supabase JS RPC interface. IN() on arrays requires unnesting.
  RETURN QUERY
    SELECT u.id, u.email::text
    FROM auth.users u
    WHERE u.id = ANY(p_user_ids);
END;
$$;

-- WHY REVOKE before GRANT: belt-and-suspenders. DEFAULT PRIVILEGES may have
-- granted execute to PUBLIC or authenticated in some Supabase project configs.
-- Explicit revoke guarantees the function is locked to service_role only.
REVOKE EXECUTE ON FUNCTION public.resolve_user_emails_for_admin(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_user_emails_for_admin(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_user_emails_for_admin(uuid[]) TO service_role;
