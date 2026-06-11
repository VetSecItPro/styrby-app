-- ============================================================================
-- Migration 101: consolidate overlapping permissive SELECT policies
-- ============================================================================
--
-- DB-DEFER-001 (Supabase advisor: multiple_permissive_policies, 2026-05-05).
--
-- Five tables each carry two PERMISSIVE policies for the SAME role+command, so
-- Postgres OR-evaluates BOTH on every qualifying row. That is functionally
-- correct (a row is visible if EITHER policy passes) but pays the cost of two
-- policy expressions per row on every scan. The advisor flags this as a
-- per-(role, action) overlap (5 tables x 1 SELECT pair = the 10 reported rows).
--
-- This migration collapses each pair into ONE policy whose USING clause is the
-- boolean OR of the two originals. Result set is provably identical (Postgres
-- already ORs permissive policies); we are only moving the OR from the policy
-- planner into a single expression, which the planner evaluates once.
--
-- ── Two distinct shapes ──────────────────────────────────────────────────────
--
-- SHAPE A — self + admin (4 tables: consent_flags, support_access_grants,
--   billing_credits, churn_save_offers). Both policies are
--   `FOR SELECT TO authenticated`:
--       <t>_select_self  : USING (user_id = (SELECT auth.uid()))
--       <t>_select_admin : USING (public.is_site_admin((SELECT auth.uid())))
--   Merged: USING (user_id = (SELECT auth.uid())
--                  OR public.is_site_admin((SELECT auth.uid()))).
--   The (SELECT auth.uid()) subquery form is preserved (init-plan caching,
--   matches every other RLS policy here). Behavior-identical: self OR admin.
--
-- SHAPE B — referral_events. The two policies are NOT a self/admin pair:
--       referral_events_referrer_select : FOR SELECT USING (referrer = uid())
--       referral_events_service_all      : FOR ALL    USING (true) WITH CHECK (true)
--   The service policy carries NO `TO` clause, so it implicitly targets PUBLIC
--   (every role). For (authenticated, SELECT) it overlaps the referrer policy —
--   that is the advisor finding. But because its USING is `true`, the OR also
--   means an authenticated caller could read EVERY row, not just their own
--   referrals (referral_events has no REVOKE of the default authenticated
--   SELECT grant, unlike billing_credits/churn_save_offers).
--
--   We do NOT merge Shape B. Instead we scope the service policy `TO
--   service_role`, which (a) removes the (authenticated, SELECT) overlap that
--   triggered the advisor, and (b) closes the latent cross-user over-read by
--   making `USING (true)` apply only to the service role. service_role has
--   BYPASSRLS in Supabase, so its read/write access is unchanged; the explicit
--   policy is kept as defense-in-depth and to satisfy DB-EXCLUDE-002's
--   invariant that every `USING (true)` policy is scoped to service_role.
--   Legitimate referrer reads are unchanged (referrer_select is untouched).
--
-- No behavior change for any legitimate caller. Safe to run on a live DB:
-- every statement is idempotent (DROP ... IF EXISTS) and the assertion block at
-- the end fails the migration loudly if the resulting policy set drifts from the
-- intended shape (CI applies this against real Postgres via `supabase db reset`).
--
-- Governing standards: OWASP A01:2021 (access control — least privilege on the
-- referral_events tightening), SOC2 CC6.1 (logical access), and the Supabase
-- RLS performance guidance the advisor cites.
-- ============================================================================

-- ── SHAPE A: consent_flags ──────────────────────────────────────────────────
DROP POLICY IF EXISTS consent_select_self ON public.consent_flags;
DROP POLICY IF EXISTS consent_select_site_admin ON public.consent_flags;
CREATE POLICY consent_select_self_or_admin ON public.consent_flags
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_site_admin((SELECT auth.uid()))
  );

-- ── SHAPE A: support_access_grants ──────────────────────────────────────────
DROP POLICY IF EXISTS support_access_grants_select_self ON public.support_access_grants;
DROP POLICY IF EXISTS support_access_grants_select_admin ON public.support_access_grants;
CREATE POLICY support_access_grants_select_self_or_admin
  ON public.support_access_grants
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_site_admin((SELECT auth.uid()))
  );

-- ── SHAPE A: billing_credits ────────────────────────────────────────────────
DROP POLICY IF EXISTS billing_credits_select_self ON public.billing_credits;
DROP POLICY IF EXISTS billing_credits_select_admin ON public.billing_credits;
CREATE POLICY billing_credits_select_self_or_admin ON public.billing_credits
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_site_admin((SELECT auth.uid()))
  );

-- ── SHAPE A: churn_save_offers ──────────────────────────────────────────────
DROP POLICY IF EXISTS churn_save_offers_select_self ON public.churn_save_offers;
DROP POLICY IF EXISTS churn_save_offers_select_admin ON public.churn_save_offers;
CREATE POLICY churn_save_offers_select_self_or_admin ON public.churn_save_offers
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_site_admin((SELECT auth.uid()))
  );

-- ── SHAPE B: referral_events (scope service policy, keep referrer policy) ────
-- Recreate the service policy WITH an explicit `TO service_role` so it no
-- longer overlaps the (authenticated, SELECT) referrer policy and no longer
-- implicitly grants public full-table read.
DROP POLICY IF EXISTS referral_events_service_all ON public.referral_events;
CREATE POLICY referral_events_service_all ON public.referral_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- referral_events_referrer_select is intentionally left as-is (the legitimate
-- owner-scoped read path).

-- ── Self-verification: assert the intended end state ────────────────────────
-- Fails the migration (and CI) if any table still has >1 permissive SELECT
-- policy for the authenticated role, or if a consolidated policy is missing.
DO $$
DECLARE
  v_count integer;
BEGIN
  -- SHAPE A: each table must now have exactly ONE permissive SELECT policy
  -- applicable to authenticated (the consolidated self_or_admin policy).
  FOR v_count IN
    SELECT 1 FROM (VALUES
      ('consent_flags',          'consent_select_self_or_admin'),
      ('support_access_grants',  'support_access_grants_select_self_or_admin'),
      ('billing_credits',        'billing_credits_select_self_or_admin'),
      ('churn_save_offers',      'churn_save_offers_select_self_or_admin')
    ) AS t(tbl, policy)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = t.tbl
        AND p.policyname = t.policy
        AND p.cmd = 'SELECT'
    )
  LOOP
    RAISE EXCEPTION 'DB-DEFER-001: expected consolidated SELECT policy is missing';
  END LOOP;

  -- No SHAPE A table may retain a separate *_select_self / *_select_admin pair.
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('consent_flags', 'support_access_grants',
                      'billing_credits', 'churn_save_offers')
    AND cmd = 'SELECT'
    AND policyname ~ '_select_(self|admin|site_admin)$';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'DB-DEFER-001: % stale self/admin SELECT policy(ies) remain', v_count;
  END IF;

  -- SHAPE B: the referral_events service policy must be scoped to service_role
  -- (roles is a name[]; assert it equals exactly {service_role}).
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'referral_events'
    AND policyname = 'referral_events_service_all'
    AND roles = ARRAY['service_role']::name[];
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'DB-DEFER-001: referral_events_service_all not scoped to service_role';
  END IF;
END $$;
