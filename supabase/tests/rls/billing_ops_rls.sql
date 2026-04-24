-- ============================================================================
-- RLS TEST SUITE: Migration 050 (billing_ops)
-- ============================================================================
--
-- PURPOSE:
--   Validates the security invariants of migration 050_billing_ops.sql for all
--   three billing-operations tables: polar_refund_events, billing_credits, and
--   churn_save_offers.
--
-- USAGE (local — requires Docker + Supabase CLI):
--   supabase db reset               # applies all migrations 001-050
--   psql "$DB_URL" -f supabase/tests/rls/billing_ops_rls.sql
--
-- CI GATE:
--   Phase 4.0 GitHub Actions workflow runs supabase db reset + this script.
--   Local Docker unavailable during T1 development; CI is the verification gate.
--
-- EXIT SEMANTICS:
--   - Each test block is wrapped in BEGIN ... ROLLBACK to avoid state pollution.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL BILLING OPS RLS TESTS PASSED".
--
-- SECURITY INVARIANTS UNDER TEST:
--
--   polar_refund_events (service_role only):
--     (a) Non-owner non-admin authenticated user sees 0 rows (deny-by-default)
--     (b) Site admin also sees 0 rows (no SELECT policy; service_role only)
--     (c) Direct INSERT denied for authenticated role (42501)
--     (d) Direct UPDATE denied for authenticated role (42501)
--     (e) Direct DELETE denied for authenticated role (42501)
--
--   billing_credits (self + admin SELECT; no DML policies):
--     (f) Non-owner non-admin sees 0 rows
--     (g) Owner (user_id = auth.uid()) sees only their own rows
--     (h) Site admin sees all rows
--     (i) Direct INSERT denied for authenticated role (42501)
--     (j) Direct UPDATE denied for authenticated role (42501)
--     (k) Direct DELETE denied for authenticated role (42501)
--
--   churn_save_offers (self + admin SELECT; no DML policies):
--     (l) Non-owner non-admin sees 0 rows
--     (m) Owner (user_id = auth.uid()) sees only their own rows
--     (n) Site admin sees all rows
--     (o) Direct INSERT denied for authenticated role (42501)
--     (p) Direct UPDATE denied for authenticated role (42501)
--     (q) Direct DELETE denied for authenticated role (42501)
--
-- SOC2 CC6.1: Least privilege — app roles cannot SELECT other users' billing
--   data; cannot directly INSERT, UPDATE, or DELETE on billing tables.
-- SOC2 CC7.2: Logical access control enforced at the database layer via RLS.
-- SOC2 CC9.2: Billing table mutations only via SECURITY DEFINER wrappers (051).
-- OWASP A01:2021: Broken Access Control mitigated at Postgres RLS + REVOKE layer.
-- GDPR Art.5: Purpose limitation — refund data restricted to service_role;
--   credit/offer data visible only to self or admin.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test harness helpers — mirrors admin_console_rls.sql exactly for consistency.
-- Idempotent CREATE OR REPLACE so running after other test files in the same
-- psql session is safe (all suites share these helpers).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _rls_test_impersonate(p_uid UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- WHY: set_config with is_local=true scopes the change to the current
  -- transaction, so it automatically reverts on ROLLBACK. Each test block
  -- starts clean without an explicit reset call between tests.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
END;
$$;

CREATE OR REPLACE FUNCTION _rls_test_reset_role()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- WHY: return to superuser (postgres) so fixture setup can bypass RLS
  -- with direct INSERTs. The 'postgres' role is Supabase local's superuser.
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Seed helper: INSERT a polar_refund_events row bypassing RLS (superuser only).
-- WHY a helper: no INSERT policy exists by design; centralize the column list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_seed_refund_event(
  p_event_id          text,
  p_actor_id          uuid,
  p_target_user_id    uuid
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.polar_refund_events
    (event_id, refund_id, amount_cents, currency, reason, actor_id, target_user_id, processed_at)
  VALUES
    (p_event_id,
     'ref_' || p_event_id,
     1000,
     'usd',
     'rls test refund',
     p_actor_id,
     p_target_user_id,
     now());
END;
$$;

-- ---------------------------------------------------------------------------
-- Seed helper: INSERT a billing_credits row bypassing RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_seed_credit(
  p_user_id    uuid,
  p_granted_by uuid
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.billing_credits
    (user_id, amount_cents, currency, reason, granted_by, granted_at)
  VALUES
    (p_user_id, 500, 'usd', 'rls test credit', p_granted_by, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Seed helper: INSERT a churn_save_offers row bypassing RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_seed_offer(
  p_user_id uuid,
  p_sent_by uuid
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.churn_save_offers
    (user_id, kind, discount_pct, discount_duration_months,
     sent_by, sent_at, expires_at, reason)
  VALUES
    (p_user_id,
     'annual_3mo_25pct',
     25,
     3,
     p_sent_by,
     now(),
     now() + interval '7 days',
     'rls test offer')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ============================================================================
-- ---- polar_refund_events tests ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (a): Non-owner non-admin sees 0 rows from polar_refund_events
-- ---------------------------------------------------------------------------
-- WHY: polar_refund_events has NO SELECT policy. deny-by-default means even
-- an authenticated user who owns no refunds sees nothing. This covers the
-- SOC2 CC6.1 requirement that app roles cannot access raw refund data.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_actor      UUID := gen_random_uuid();
  v_target     UUID := gen_random_uuid();
  v_stranger   UUID := gen_random_uuid();
  v_count      INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_actor,   'actor_a@bops.test',   'x', now(), now()),
    (v_target,  'target_a@bops.test',  'x', now(), now()),
    (v_stranger,'stranger_a@bops.test','x', now(), now());

  PERFORM _rls_seed_refund_event('evt_test_a_1', v_actor, v_target);

  -- Stranger (non-owner, non-admin) should see nothing
  PERFORM _rls_test_impersonate(v_stranger);
  SELECT count(*) INTO v_count FROM public.polar_refund_events;
  PERFORM _rls_test_reset_role();

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST (a) FAILED: non-owner stranger sees % polar_refund_events rows, expected 0', v_count;
  END IF;

  RAISE NOTICE 'TEST (a) PASS: non-owner non-admin sees 0 polar_refund_events rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (b): Site admin also sees 0 rows from polar_refund_events
-- ---------------------------------------------------------------------------
-- WHY: polar_refund_events has NO RLS SELECT policies at all — not even for
-- site_admin.  Admins access refund records via admin_audit_log, which is the
-- canonical admin view (spec §3.1).  This test ensures no accidental policy
-- was added that would bypass the "service_role only" intent.
-- SOC2 CC6.1: Even privileged app roles are denied direct access to raw refunds.
-- GDPR Art.5: polar_response_json may contain payment PII; admin dossier
--   surfaces only the audit_log row (which contains no raw PII).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_actor  UUID := gen_random_uuid();
  v_target UUID := gen_random_uuid();
  v_admin  UUID := gen_random_uuid();
  v_count  INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_actor,  'actor_b@bops.test',  'x', now(), now()),
    (v_target, 'target_b@bops.test', 'x', now(), now()),
    (v_admin,  'admin_b@bops.test',  'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed b');

  PERFORM _rls_seed_refund_event('evt_test_b_1', v_actor, v_target);

  -- Site admin has no SELECT policy on this table — must also see 0 rows
  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_count FROM public.polar_refund_events;
  PERFORM _rls_test_reset_role();

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: site admin sees % polar_refund_events rows, expected 0', v_count;
  END IF;

  RAISE NOTICE 'TEST (b) PASS: site admin sees 0 polar_refund_events rows (service_role-only table)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (c): Direct INSERT into polar_refund_events denied (42501)
-- ---------------------------------------------------------------------------
-- WHY: REVOKE INSERT from authenticated is the outer defense layer.  Without
-- this test a regression reintroducing INSERT privilege to authenticated would
-- be silently exploitable by any logged-in user injecting fake refund events.
-- SOC2 CC9.2: Refund event creation is service_role-only; REVOKE + test proves it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES (v_user, 'user_c@bops.test', 'x', now(), now());

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    INSERT INTO public.polar_refund_events
      (event_id, refund_id, amount_cents, currency, reason, actor_id, target_user_id)
    VALUES
      ('evt_c_inject', 'ref_c', 100, 'usd', 'injected', v_user, v_user);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (c) FAILED: INSERT into polar_refund_events expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (c) PASS: direct INSERT into polar_refund_events denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (d): Direct UPDATE on polar_refund_events denied (42501)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_actor  UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_actor,  'actor_d@bops.test',  'x', now(), now()),
    (v_target, 'target_d@bops.test', 'x', now(), now());

  PERFORM _rls_seed_refund_event('evt_test_d_1', v_actor, v_target);

  PERFORM _rls_test_impersonate(v_actor);
  BEGIN
    UPDATE public.polar_refund_events SET reason = 'TAMPERED' WHERE event_id = 'evt_test_d_1';
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (d) FAILED: UPDATE on polar_refund_events expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (d) PASS: direct UPDATE on polar_refund_events denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (e): Direct DELETE on polar_refund_events denied (42501)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_actor  UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_actor,  'actor_e@bops.test',  'x', now(), now()),
    (v_target, 'target_e@bops.test', 'x', now(), now());

  PERFORM _rls_seed_refund_event('evt_test_e_1', v_actor, v_target);

  PERFORM _rls_test_impersonate(v_actor);
  BEGIN
    DELETE FROM public.polar_refund_events WHERE event_id = 'evt_test_e_1';
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (e) FAILED: DELETE on polar_refund_events expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (e) PASS: direct DELETE on polar_refund_events denied (42501)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- billing_credits tests ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (f): Non-owner non-admin sees 0 billing_credits rows
-- ---------------------------------------------------------------------------
-- WHY: User A must not see User B's credits. Leaking credit balances would
-- expose internal customer satisfaction data and erode trust.
-- SOC2 CC6.1: Billing data scoped to the owning user at the DB layer.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_owner    UUID := gen_random_uuid();
  v_admin    UUID := gen_random_uuid();
  v_stranger UUID := gen_random_uuid();
  v_count    INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_owner,   'owner_f@bops.test',   'x', now(), now()),
    (v_admin,   'admin_f@bops.test',   'x', now(), now()),
    (v_stranger,'stranger_f@bops.test','x', now(), now());

  -- Seed one credit for v_owner (granted by v_admin)
  PERFORM _rls_seed_credit(v_owner, v_admin);

  -- Stranger sees nothing
  PERFORM _rls_test_impersonate(v_stranger);
  SELECT count(*) INTO v_count FROM public.billing_credits;
  PERFORM _rls_test_reset_role();

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST (f) FAILED: stranger sees % billing_credits rows, expected 0', v_count;
  END IF;

  RAISE NOTICE 'TEST (f) PASS: non-owner non-admin sees 0 billing_credits rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (g): Owner sees only their own billing_credits rows
-- ---------------------------------------------------------------------------
-- WHY: The self-SELECT policy (user_id = auth.uid()) must scope results exactly.
-- A user with 1 credit must see exactly 1 row; a different user's credits must
-- be invisible.  Tests both the positive (self-row visible) and negative
-- (other user's row invisible) sides of the policy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner_a  UUID := gen_random_uuid();
  v_owner_b  UUID := gen_random_uuid();
  v_admin    UUID := gen_random_uuid();
  v_count_a  INT;
  v_count_b  INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_owner_a, 'owner_ga@bops.test', 'x', now(), now()),
    (v_owner_b, 'owner_gb@bops.test', 'x', now(), now()),
    (v_admin,   'admin_g@bops.test',  'x', now(), now());

  -- Seed 2 credits for owner_a, 1 for owner_b
  PERFORM _rls_seed_credit(v_owner_a, v_admin);
  PERFORM _rls_seed_credit(v_owner_a, v_admin);
  PERFORM _rls_seed_credit(v_owner_b, v_admin);

  -- owner_a sees only their own 2 rows
  PERFORM _rls_test_impersonate(v_owner_a);
  SELECT count(*) INTO v_count_a FROM public.billing_credits;
  PERFORM _rls_test_reset_role();

  -- owner_b sees only their own 1 row
  PERFORM _rls_test_impersonate(v_owner_b);
  SELECT count(*) INTO v_count_b FROM public.billing_credits;
  PERFORM _rls_test_reset_role();

  IF v_count_a <> 2 THEN
    RAISE EXCEPTION 'TEST (g) FAILED: owner_a sees % credits, expected 2', v_count_a;
  END IF;
  IF v_count_b <> 1 THEN
    RAISE EXCEPTION 'TEST (g) FAILED: owner_b sees % credits, expected 1', v_count_b;
  END IF;

  RAISE NOTICE 'TEST (g) PASS: credit owner sees only their own rows (owner_a=2, owner_b=1)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (h): Site admin sees all billing_credits rows
-- ---------------------------------------------------------------------------
-- WHY: Admin dossier requires cross-user credit visibility for billing ops.
-- Without the admin SELECT policy the dossier would silently show no credits,
-- hiding data the admin needs to make support decisions.
-- SOC2 CC7.2: Admin access is policy-gated, not bypassing RLS entirely.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user_a UUID := gen_random_uuid();
  v_user_b UUID := gen_random_uuid();
  v_admin  UUID := gen_random_uuid();
  v_count  INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user_a, 'usera_h@bops.test', 'x', now(), now()),
    (v_user_b, 'userb_h@bops.test', 'x', now(), now()),
    (v_admin,  'admin_h@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed h');

  PERFORM _rls_seed_credit(v_user_a, v_admin);
  PERFORM _rls_seed_credit(v_user_b, v_admin);

  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_count FROM public.billing_credits;
  PERFORM _rls_test_reset_role();

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'TEST (h) FAILED: site admin sees % billing_credits rows, expected 2', v_count;
  END IF;

  RAISE NOTICE 'TEST (h) PASS: site admin sees all billing_credits rows (count=2)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (i): Direct INSERT into billing_credits denied (42501)
-- ---------------------------------------------------------------------------
-- WHY: Without REVOKE, an authenticated user could create fake credits for
-- themselves by calling INSERT directly.  REVOKE + this test proves the lock.
-- SOC2 CC9.2: Credit creation must flow through admin_issue_credit wrapper only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES (v_user, 'user_i@bops.test', 'x', now(), now());

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    INSERT INTO public.billing_credits
      (user_id, amount_cents, currency, reason, granted_by, granted_at)
    VALUES
      (v_user, 9999999, 'usd', 'self-grant', v_user, now());
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (i) FAILED: INSERT into billing_credits expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (i) PASS: direct INSERT into billing_credits denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (j): Direct UPDATE on billing_credits denied (42501)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner  UUID    := gen_random_uuid();
  v_admin  UUID    := gen_random_uuid();
  v_cred   bigint;
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_owner, 'owner_j@bops.test', 'x', now(), now()),
    (v_admin, 'admin_j@bops.test', 'x', now(), now());

  SELECT _rls_seed_credit(v_owner, v_admin) INTO v_cred;

  -- Even the owner cannot UPDATE their own credit row
  PERFORM _rls_test_impersonate(v_owner);
  BEGIN
    UPDATE public.billing_credits SET amount_cents = 9999999 WHERE id = v_cred;
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (j) FAILED: UPDATE on billing_credits expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (j) PASS: direct UPDATE on billing_credits denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (k): Direct DELETE on billing_credits denied (42501)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner  UUID    := gen_random_uuid();
  v_admin  UUID    := gen_random_uuid();
  v_cred   bigint;
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_owner, 'owner_k@bops.test', 'x', now(), now()),
    (v_admin, 'admin_k@bops.test', 'x', now(), now());

  SELECT _rls_seed_credit(v_owner, v_admin) INTO v_cred;

  PERFORM _rls_test_impersonate(v_owner);
  BEGIN
    DELETE FROM public.billing_credits WHERE id = v_cred;
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (k) FAILED: DELETE on billing_credits expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (k) PASS: direct DELETE on billing_credits denied (42501)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- churn_save_offers tests ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (l): Non-owner non-admin sees 0 churn_save_offers rows
-- ---------------------------------------------------------------------------
-- WHY: Offer details (discount_pct, polar_discount_code) are commercially
-- sensitive.  A stranger must not discover what discount another user was
-- offered, which could be used to demand the same treatment.
-- SOC2 CC6.1: Offer data scoped to the owning user at the DB layer.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_user_a  UUID := gen_random_uuid();
  v_admin   UUID := gen_random_uuid();
  v_stranger UUID := gen_random_uuid();
  v_count   INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user_a,  'usera_l@bops.test',  'x', now(), now()),
    (v_admin,   'admin_l@bops.test',  'x', now(), now()),
    (v_stranger,'strange_l@bops.test','x', now(), now());

  PERFORM _rls_seed_offer(v_user_a, v_admin);

  PERFORM _rls_test_impersonate(v_stranger);
  SELECT count(*) INTO v_count FROM public.churn_save_offers;
  PERFORM _rls_test_reset_role();

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST (l) FAILED: stranger sees % churn_save_offers rows, expected 0', v_count;
  END IF;

  RAISE NOTICE 'TEST (l) PASS: non-owner non-admin sees 0 churn_save_offers rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (m): Owner sees only their own churn_save_offers rows
-- ---------------------------------------------------------------------------
-- WHY: User A's offer (polar_discount_code, discount_pct) must not be visible
-- to User B.  This test confirms the self-SELECT policy works for both sides.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user_a UUID := gen_random_uuid();
  v_user_b UUID := gen_random_uuid();
  v_admin  UUID := gen_random_uuid();
  v_cnt_a  INT;
  v_cnt_b  INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user_a, 'usera_m@bops.test', 'x', now(), now()),
    (v_user_b, 'userb_m@bops.test', 'x', now(), now()),
    (v_admin,  'admin_m@bops.test', 'x', now(), now());

  -- 1 offer for user_a, 2 offers for user_b (to test distinct counts)
  PERFORM _rls_seed_offer(v_user_a, v_admin);
  PERFORM _rls_seed_offer(v_user_b, v_admin);
  PERFORM _rls_seed_offer(v_user_b, v_admin);

  PERFORM _rls_test_impersonate(v_user_a);
  SELECT count(*) INTO v_cnt_a FROM public.churn_save_offers;
  PERFORM _rls_test_reset_role();

  PERFORM _rls_test_impersonate(v_user_b);
  SELECT count(*) INTO v_cnt_b FROM public.churn_save_offers;
  PERFORM _rls_test_reset_role();

  IF v_cnt_a <> 1 THEN
    RAISE EXCEPTION 'TEST (m) FAILED: user_a sees % offers, expected 1', v_cnt_a;
  END IF;
  IF v_cnt_b <> 2 THEN
    RAISE EXCEPTION 'TEST (m) FAILED: user_b sees % offers, expected 2', v_cnt_b;
  END IF;

  RAISE NOTICE 'TEST (m) PASS: owner sees only their own churn_save_offers (user_a=1, user_b=2)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (n): Site admin sees all churn_save_offers rows
-- ---------------------------------------------------------------------------
-- WHY: Admin needs cross-user visibility for churn analysis and offer management.
-- Without the admin SELECT policy, the dossier would silently show no offers.
-- SOC2 CC7.2: Admin access is RLS-policy-gated (not raw RLS bypass).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user_a UUID := gen_random_uuid();
  v_user_b UUID := gen_random_uuid();
  v_admin  UUID := gen_random_uuid();
  v_count  INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user_a, 'usera_n@bops.test', 'x', now(), now()),
    (v_user_b, 'userb_n@bops.test', 'x', now(), now()),
    (v_admin,  'admin_n@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed n');

  PERFORM _rls_seed_offer(v_user_a, v_admin);
  PERFORM _rls_seed_offer(v_user_b, v_admin);

  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_count FROM public.churn_save_offers;
  PERFORM _rls_test_reset_role();

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'TEST (n) FAILED: site admin sees % offers, expected 2', v_count;
  END IF;

  RAISE NOTICE 'TEST (n) PASS: site admin sees all churn_save_offers rows (count=2)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (o): Direct INSERT into churn_save_offers denied (42501)
-- ---------------------------------------------------------------------------
-- WHY: A user injecting their own offer row could fabricate a polar_discount_code
-- and redeem a discount that was never authorized.  REVOKE prevents this; this
-- test is the regression guard.
-- SOC2 CC9.2: Offer creation must flow through admin_send_churn_save_offer only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_admin  UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,  'user_o@bops.test',  'x', now(), now()),
    (v_admin, 'admin_o@bops.test', 'x', now(), now());

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    INSERT INTO public.churn_save_offers
      (user_id, kind, discount_pct, discount_duration_months,
       sent_by, sent_at, expires_at, reason)
    VALUES
      (v_user, 'annual_3mo_25pct', 25, 3, v_user, now(), now() + interval '7 days', 'self-created');
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (o) FAILED: INSERT into churn_save_offers expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (o) PASS: direct INSERT into churn_save_offers denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (p): Direct UPDATE on churn_save_offers denied (42501)
-- ---------------------------------------------------------------------------
-- WHY: A user updating accepted_at on their own offer row could self-accept an
-- expired offer or revoke one sent to another user.  REVOKE blocks this;
-- mutations flow only through user_accept_churn_save_offer wrapper (051).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_admin  UUID    := gen_random_uuid();
  v_offer  bigint;
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,  'user_p@bops.test',  'x', now(), now()),
    (v_admin, 'admin_p@bops.test', 'x', now(), now());

  SELECT _rls_seed_offer(v_user, v_admin) INTO v_offer;

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    UPDATE public.churn_save_offers SET accepted_at = now() WHERE id = v_offer;
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (p) FAILED: UPDATE on churn_save_offers expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (p) PASS: direct UPDATE on churn_save_offers denied (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (q): Direct DELETE on churn_save_offers denied (42501)
-- ---------------------------------------------------------------------------
-- WHY: A user deleting their offer row could erase evidence of having received
-- a discount attempt, complicating support audits.  REVOKE prevents deletion
-- from app layer; all lifecycle changes go through wrappers.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_admin  UUID    := gen_random_uuid();
  v_offer  bigint;
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,  'user_q@bops.test',  'x', now(), now()),
    (v_admin, 'admin_q@bops.test', 'x', now(), now());

  SELECT _rls_seed_offer(v_user, v_admin) INTO v_offer;

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    DELETE FROM public.churn_save_offers WHERE id = v_offer;
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (q) FAILED: DELETE on churn_save_offers expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (q) PASS: direct DELETE on churn_save_offers denied (42501)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- All tests passed
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE '=== ALL BILLING OPS RLS TESTS PASSED ===';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test harness cleanup — drop helper functions to avoid schema pollution.
-- WHY: _rls_test_impersonate and related helpers are test-only constructs.
-- Leaving them in the DB creates an unnecessary attack surface: a malicious
-- caller could invoke them to elevate apparent role context. Dropping them
-- ensures a clean schema after the test suite runs (mirrors admin_console_rls.sql).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
DROP FUNCTION IF EXISTS _rls_test_reset_role();
DROP FUNCTION IF EXISTS _rls_seed_refund_event(text, uuid, uuid);
DROP FUNCTION IF EXISTS _rls_seed_credit(uuid, uuid);
DROP FUNCTION IF EXISTS _rls_seed_offer(uuid, uuid);
