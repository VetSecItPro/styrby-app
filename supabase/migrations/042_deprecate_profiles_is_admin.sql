-- ============================================================================
-- Migration 042: Deprecate profiles.is_admin — cutover to site_admins table
--
-- Phase 4.1 T3.5 — see spec §6 (task row T3.5) and PR #154.
--
-- CUTOVER STRATEGY
-- ────────────────
-- This migration performs the READ-side cutover for the is_admin → site_admins
-- migration. It does NOT drop the column (that is deferred to a future polish
-- phase after all readers have been verified migrated and a grace period passes).
--
-- Step-by-step:
--   1. Bootstrap site_admins from any profiles rows where is_admin = true.
--      WHY: We must not create a window where a currently-valid admin loses
--      access. Bootstrapping before marking the column deprecated ensures
--      continuous admin access through the cutover — no downtime, no
--      revocation-then-re-grant gap.
--
--   2. Mark profiles.is_admin as DEPRECATED via a column comment.
--      WHY comment not constraint: We cannot add a CHECK constraint that
--      prevents writes to a legacy column without breaking old code that
--      still writes it. A comment is the lowest-risk deprecation signal —
--      visible in pg_catalog, DBeaver, and Supabase dashboard tooltips.
--
--   3. Column is intentionally NOT dropped in this migration.
--      WHY: Dropping too early risks a race condition if any in-flight
--      application instance (Vercel function that hasn't redeployed yet)
--      still reads profiles.is_admin. The safe pattern is:
--        040 → create site_admins table (done)
--        041 → SECURITY DEFINER wrappers (done)
--        042 → bootstrap + deprecate column (this migration)
--        [app deploy] → cut all code over to is_site_admin() RPC
--        [future] → DROP COLUMN after 1+ release cycle grace period
--
-- SOC 2 CC6.1 (Logical Access Controls): The single source of truth for admin
-- authorization must not be split across two locations. This migration begins
-- the formal consolidation into site_admins with a documented cutover path.
--
-- OWASP A01:2021 (Broken Access Control): Removing the is_admin column
-- without bootstrapping site_admins first would silently revoke all admin
-- access. The bootstrap INSERT below prevents that failure mode.
-- ============================================================================


-- ============================================================================
-- Step 1: Bootstrap site_admins from existing profiles.is_admin = true rows
--
-- WHY ON CONFLICT DO NOTHING: If an admin was already added to site_admins
-- manually before this migration runs (e.g. in development or via a prior
-- bootstrap script), we must not overwrite their row or error out.
--
-- WHY `note` field: The site_admins table has a NOT NULL note column (migration
-- 040). We record the migration source and timestamp so an auditor can trace
-- how each row entered the allowlist. The timestamp in the note uses now()::text
-- so it matches the transaction time — not an arbitrary future reference.
--
-- WHY added_by = NULL: For auto-migrated rows, there is no human admin who
-- initiated the grant — the row existed in profiles before site_admins was
-- introduced. NULL is the correct sentinel for "bootstrap / system-initiated"
-- as documented in the migration 040 column comment.
-- ============================================================================

INSERT INTO public.site_admins (user_id, added_at, added_by, note)
SELECT
    p.id,
    now(),
    NULL,
    'auto-migrated from profiles.is_admin on ' || now()::text
FROM public.profiles p
WHERE p.is_admin = true
ON CONFLICT (user_id) DO NOTHING;


-- ============================================================================
-- Step 1b: Tighten is_site_admin EXECUTE privilege to service_role only (T3.5 threat review follow-up)
--
-- WHY: Migration 040 granted EXECUTE on is_site_admin to `authenticated`. Any logged-in user
-- could call `rpc('is_site_admin', { p_user_id: <any-uuid> })` and receive a boolean revealing
-- whether that UUID is a site admin. Low-value info (boolean only, no metadata) but a
-- clear RLS-bypass surface vs the `site_admins_select_self` policy which limits SELECT to
-- caller's own row. All current callers (lib/admin.ts, dashboard/admin/layout.tsx) use the
-- service-role client (createAdminClient), so tightening to service_role has zero impact on
-- production behavior.
--
-- Governing: SOC2 CC6.1 (least privilege), OWASP ASVS V4.1.3 (principle of least functionality).
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.is_site_admin(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_site_admin(uuid) TO service_role;


-- ============================================================================
-- Step 2: Mark profiles.is_admin as deprecated via column comment
--
-- WHY: A column comment is visible in:
--   - Supabase Dashboard → Table Editor → column tooltip
--   - DBeaver / pgAdmin → column properties
--   - pg_catalog.pg_description (SELECT obj_description(...))
-- This makes the deprecation discoverable by any developer who inspects the
-- schema, without needing to grep the codebase or read migration history.
--
-- The comment explicitly cites:
--   - The replacement (public.site_admins table + public.is_site_admin())
--   - The PR that performed the application-layer cutover (#154)
--   - The phase this belongs to (Phase 4.1 T3.5)
--   - The date the deprecation was declared (2026-04-23)
--   - The future DROP intent (deferred, not forgotten)
-- ============================================================================

COMMENT ON COLUMN public.profiles.is_admin IS
    'DEPRECATED 2026-04-23: use public.site_admins table + public.is_site_admin() function. '
    'Column retained for Phase 4.1 T3.5 cutover (PR #154); '
    'scheduled for DROP in a future polish phase after all readers verified migrated. '
    'Do NOT read this column in new code — call supabase.rpc(''is_site_admin'', { p_user_id }) instead.';


-- ============================================================================
-- Migration 042 complete.
-- Steps performed:
--   1. Bootstrapped site_admins from profiles.is_admin = true rows.
--   1b. Tightened is_site_admin EXECUTE privilege from authenticated → service_role.
--   2. Marked profiles.is_admin as DEPRECATED via column comment.
-- ============================================================================
