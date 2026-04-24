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
-- ---- admin_issue_refund tests (migration 051) ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (r-1): admin_issue_refund happy path — returns audit_id, row created
-- ---------------------------------------------------------------------------
-- WHY: Verifies the baseline success path: admin calls with valid parameters,
-- polar_refund_events row is inserted, admin_audit_log row is inserted, and a
-- positive bigint audit_id is returned. This is the primary confidence gate
-- for the refund wrapper before testing error branches.
-- SOC2 CC9.2: Refund creation flows correctly through the SECURITY DEFINER wrapper.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin    UUID    := gen_random_uuid();
  v_target   UUID    := gen_random_uuid();
  v_audit_id bigint;
  v_refund_count int;
  v_audit_count  int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_r1@bops.test',  'x', now(), now()),
    (v_target, 'target_r1@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed r1');

  -- Call via impersonated admin (authenticated role + JWT)
  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_issue_refund(
    v_target, 5000, 'usd', 'test refund r1',
    'evt_r1_001', 'ref_r1_001', NULL,
    '{"status":"succeeded"}'::jsonb
  ) INTO v_audit_id;
  PERFORM _rls_test_reset_role();

  -- Verify audit_id is positive
  IF v_audit_id IS NULL OR v_audit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (r-1) FAILED: expected positive audit_id, got %', v_audit_id;
  END IF;

  -- Verify polar_refund_events row was inserted (superuser SELECT bypasses RLS)
  SELECT count(*) INTO v_refund_count
    FROM public.polar_refund_events
    WHERE event_id = 'evt_r1_001';

  IF v_refund_count <> 1 THEN
    RAISE EXCEPTION 'TEST (r-1) FAILED: expected 1 polar_refund_events row, got %', v_refund_count;
  END IF;

  -- Verify admin_audit_log row was inserted with correct action
  SELECT count(*) INTO v_audit_count
    FROM public.admin_audit_log
    WHERE id = v_audit_id
      AND action = 'refund_issued'
      AND target_user_id = v_target;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (r-1) FAILED: expected 1 admin_audit_log row with id=%, got %', v_audit_id, v_audit_count;
  END IF;

  RAISE NOTICE 'TEST (r-1) PASS: admin_issue_refund happy path, audit_id=%', v_audit_id;
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (r-2): admin_issue_refund — non-admin gets 42501
-- ---------------------------------------------------------------------------
-- WHY: Core security invariant — an authenticated non-admin must not be able to
-- call admin_issue_refund. This test verifies the is_site_admin() check inside the
-- SECURITY DEFINER body rejects non-admin callers even though GRANT is to
-- 'authenticated' (Phase 4.1 P0 pattern — defense-in-depth).
-- SOC2 CC6.1: Least-privilege enforced at the function body level.
-- OWASP A01:2021: Broken Access Control prevented by in-body is_site_admin guard.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,   'user_r2@bops.test',   'x', now(), now()),
    (v_target, 'target_r2@bops.test', 'x', now(), now());

  -- Non-admin call — must raise 42501
  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    PERFORM public.admin_issue_refund(
      v_target, 5000, 'usd', 'should be rejected',
      'evt_r2_001', 'ref_r2_001', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (r-2) FAILED: expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (r-2) PASS: non-admin admin_issue_refund rejected (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (r-3): admin_issue_refund — amount_cents cap validation (22023)
-- ---------------------------------------------------------------------------
-- WHY: Validates the $5000 cap (500000 cents) and the zero/negative guard.
-- Without this test a regression removing the cap check would allow arbitrary
-- refund amounts to be recorded, creating a financial liability.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin   UUID    := gen_random_uuid();
  v_target  UUID    := gen_random_uuid();
  v_caught1 BOOLEAN := FALSE;
  v_caught2 BOOLEAN := FALSE;
  v_caught3 BOOLEAN := FALSE;
  v_code    text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_r3@bops.test',  'x', now(), now()),
    (v_target, 'target_r3@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed r3');

  PERFORM _rls_test_impersonate(v_admin);

  -- Over cap: 500001 cents = $5000.01 — must raise 22023
  BEGIN
    PERFORM public.admin_issue_refund(
      v_target, 500001, 'usd', 'over cap',
      'evt_r3_over', 'ref_r3_over', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught1 := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;

  IF NOT v_caught1 OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (r-3a) FAILED: over-cap expected 22023, got caught=% code=%', v_caught1, v_code;
  END IF;

  -- Zero amount — must raise 22023
  BEGIN
    PERFORM public.admin_issue_refund(
      v_target, 0, 'usd', 'zero amount',
      'evt_r3_zero', 'ref_r3_zero', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught2 := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;

  IF NOT v_caught2 OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (r-3b) FAILED: zero amount expected 22023, got caught=% code=%', v_caught2, v_code;
  END IF;

  -- Negative amount — must raise 22023
  BEGIN
    PERFORM public.admin_issue_refund(
      v_target, -100, 'usd', 'negative amount',
      'evt_r3_neg', 'ref_r3_neg', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught3 := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;

  IF NOT v_caught3 OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (r-3c) FAILED: negative amount expected 22023, got caught=% code=%', v_caught3, v_code;
  END IF;

  PERFORM _rls_test_reset_role();

  RAISE NOTICE 'TEST (r-3) PASS: admin_issue_refund cap validation correct (over-cap, zero, negative all reject 22023)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (r-4): admin_issue_refund — idempotency on duplicate polar_event_id
-- ---------------------------------------------------------------------------
-- WHY: Polar has at-least-once webhook delivery. Calling admin_issue_refund twice
-- with the same event_id must not create a second polar_refund_events row or a
-- second admin_audit_log row. The returned audit_id must be identical on both
-- calls (idempotent return value). This is the core SOC2 CC9.2 guarantee.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID   := gen_random_uuid();
  v_target    UUID   := gen_random_uuid();
  v_audit1    bigint;
  v_audit2    bigint;
  v_evt_count int;
  v_aud_count int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_r4@bops.test',  'x', now(), now()),
    (v_target, 'target_r4@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed r4');

  PERFORM _rls_test_impersonate(v_admin);

  -- First call — new insert
  SELECT public.admin_issue_refund(
    v_target, 1000, 'usd', 'idempotent refund r4',
    'evt_r4_idem', 'ref_r4_001', NULL, '{}'::jsonb
  ) INTO v_audit1;

  -- Second call — same event_id — must be idempotent
  SELECT public.admin_issue_refund(
    v_target, 1000, 'usd', 'idempotent refund r4 replay',
    'evt_r4_idem', 'ref_r4_001', NULL, '{}'::jsonb
  ) INTO v_audit2;

  PERFORM _rls_test_reset_role();

  -- Only 1 polar_refund_events row must exist (ON CONFLICT DO NOTHING)
  SELECT count(*) INTO v_evt_count
    FROM public.polar_refund_events
    WHERE event_id = 'evt_r4_idem';

  IF v_evt_count <> 1 THEN
    RAISE EXCEPTION 'TEST (r-4) FAILED: expected 1 polar_refund_events row, got %', v_evt_count;
  END IF;

  -- Only 1 admin_audit_log row for this event must exist
  SELECT count(*) INTO v_aud_count
    FROM public.admin_audit_log
    WHERE action = 'refund_issued'
      AND after_json->>'polar_event_id' = 'evt_r4_idem';

  IF v_aud_count <> 1 THEN
    RAISE EXCEPTION 'TEST (r-4) FAILED: expected 1 audit row, got %', v_aud_count;
  END IF;

  -- The second call must return the same audit_id as the first
  IF v_audit1 IS NULL OR v_audit1 <= 0 THEN
    RAISE EXCEPTION 'TEST (r-4) FAILED: first call returned invalid audit_id %', v_audit1;
  END IF;

  IF v_audit2 <> v_audit1 THEN
    RAISE EXCEPTION 'TEST (r-4) FAILED: second call returned % but expected % (idempotent)', v_audit2, v_audit1;
  END IF;

  RAISE NOTICE 'TEST (r-4) PASS: admin_issue_refund idempotent on duplicate event_id (audit_id=% on both calls)', v_audit1;
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- admin_issue_credit tests (migration 051) ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (s-1): admin_issue_credit happy path — returns (audit_id, credit_id)
-- ---------------------------------------------------------------------------
-- WHY: Verifies baseline success path. Admin calls with valid params; billing_credits
-- row is inserted; admin_audit_log row is inserted; positive (audit_id, credit_id)
-- returned. This is the primary confidence gate before testing error branches.
-- SOC2 CC9.2: Credit creation correctly flows through the SECURITY DEFINER wrapper.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin     UUID   := gen_random_uuid();
  v_target    UUID   := gen_random_uuid();
  v_audit_id  bigint;
  v_credit_id bigint;
  v_cred_cnt  int;
  v_aud_cnt   int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_s1@bops.test',  'x', now(), now()),
    (v_target, 'target_s1@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed s1');

  PERFORM _rls_test_impersonate(v_admin);
  SELECT r.audit_id, r.credit_id
    INTO v_audit_id, v_credit_id
    FROM public.admin_issue_credit(v_target, 2500, 'usd', 'test credit s1', NULL) r;
  PERFORM _rls_test_reset_role();

  IF v_audit_id IS NULL OR v_audit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (s-1) FAILED: expected positive audit_id, got %', v_audit_id;
  END IF;
  IF v_credit_id IS NULL OR v_credit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (s-1) FAILED: expected positive credit_id, got %', v_credit_id;
  END IF;

  SELECT count(*) INTO v_cred_cnt
    FROM public.billing_credits
    WHERE id = v_credit_id AND user_id = v_target;

  IF v_cred_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST (s-1) FAILED: expected 1 billing_credits row, got %', v_cred_cnt;
  END IF;

  SELECT count(*) INTO v_aud_cnt
    FROM public.admin_audit_log
    WHERE id = v_audit_id AND action = 'credit_issued' AND target_user_id = v_target;

  IF v_aud_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST (s-1) FAILED: expected 1 audit row, got %', v_aud_cnt;
  END IF;

  RAISE NOTICE 'TEST (s-1) PASS: admin_issue_credit happy path, audit_id=%, credit_id=%', v_audit_id, v_credit_id;
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (s-2): admin_issue_credit — non-admin gets 42501
-- ---------------------------------------------------------------------------
-- WHY: Same OWASP A01:2021 check as r-2. An authenticated non-admin must not
-- be able to issue credits to any user (including themselves).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,   'user_s2@bops.test',   'x', now(), now()),
    (v_target, 'target_s2@bops.test', 'x', now(), now());

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    PERFORM public.admin_issue_credit(v_target, 100, 'usd', 'self-credit', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (s-2) FAILED: expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (s-2) PASS: non-admin admin_issue_credit rejected (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (s-3): admin_issue_credit — amount_cents cap validation (22023)
-- ---------------------------------------------------------------------------
-- WHY: Cap at $1000 (100000 cents) prevents accidentally large credits.
-- This test covers the over-cap and zero cases. Negative implicitly covered
-- by the over-cap / zero tests (all paths through the same guard).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin   UUID    := gen_random_uuid();
  v_target  UUID    := gen_random_uuid();
  v_caught1 BOOLEAN := FALSE;
  v_caught2 BOOLEAN := FALSE;
  v_code    text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_s3@bops.test',  'x', now(), now()),
    (v_target, 'target_s3@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed s3');

  PERFORM _rls_test_impersonate(v_admin);

  -- Over cap: 100001 cents = $1000.01
  BEGIN
    PERFORM public.admin_issue_credit(v_target, 100001, 'usd', 'over cap', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught1 := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;

  IF NOT v_caught1 OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (s-3a) FAILED: over-cap expected 22023, got caught=% code=%', v_caught1, v_code;
  END IF;

  -- Zero amount
  BEGIN
    PERFORM public.admin_issue_credit(v_target, 0, 'usd', 'zero', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught2 := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;

  IF NOT v_caught2 OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (s-3b) FAILED: zero amount expected 22023, got caught=% code=%', v_caught2, v_code;
  END IF;

  PERFORM _rls_test_reset_role();

  RAISE NOTICE 'TEST (s-3) PASS: admin_issue_credit cap validation correct (over-cap=22023, zero=22023)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- admin_revoke_credit tests (migration 051) ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (t-1): admin_revoke_credit happy path — revoked_at set, audit row created
-- ---------------------------------------------------------------------------
-- WHY: Baseline success path. Admin revokes an unapplied credit; revoked_at is
-- set on the billing_credits row; audit row is written with before/after diff.
-- SOC2 CC9.2: Revocation correctly flows through the SECURITY DEFINER wrapper.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin     UUID   := gen_random_uuid();
  v_owner     UUID   := gen_random_uuid();
  v_credit_id bigint;
  v_audit_id  bigint;
  v_rev_at    timestamptz;
  v_aud_cnt   int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_t1@bops.test', 'x', now(), now()),
    (v_owner, 'owner_t1@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed t1');

  -- Seed an unapplied credit (superuser bypass)
  SELECT _rls_seed_credit(v_owner, v_admin) INTO v_credit_id;

  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_revoke_credit(v_credit_id, 'test revoke t1') INTO v_audit_id;
  PERFORM _rls_test_reset_role();

  IF v_audit_id IS NULL OR v_audit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (t-1) FAILED: expected positive audit_id, got %', v_audit_id;
  END IF;

  -- Verify revoked_at is set on the credit row
  SELECT revoked_at INTO v_rev_at
    FROM public.billing_credits WHERE id = v_credit_id;

  IF v_rev_at IS NULL THEN
    RAISE EXCEPTION 'TEST (t-1) FAILED: revoked_at not set on billing_credits row';
  END IF;

  -- Verify audit row
  SELECT count(*) INTO v_aud_cnt
    FROM public.admin_audit_log
    WHERE id = v_audit_id AND action = 'credit_revoked' AND target_user_id = v_owner;

  IF v_aud_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST (t-1) FAILED: expected 1 credit_revoked audit row, got %', v_aud_cnt;
  END IF;

  RAISE NOTICE 'TEST (t-1) PASS: admin_revoke_credit happy path, audit_id=%', v_audit_id;
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (t-2): admin_revoke_credit — non-admin gets 42501
-- ---------------------------------------------------------------------------
-- WHY: An authenticated non-admin must not be able to revoke any credit.
-- Without this test a GRANT regression could allow arbitrary revocation.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user      UUID    := gen_random_uuid();
  v_admin_seed UUID   := gen_random_uuid();
  v_credit_id bigint;
  v_caught    BOOLEAN := FALSE;
  v_code      text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,       'user_t2@bops.test',  'x', now(), now()),
    (v_admin_seed, 'aseed_t2@bops.test', 'x', now(), now());

  SELECT _rls_seed_credit(v_user, v_admin_seed) INTO v_credit_id;

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    PERFORM public.admin_revoke_credit(v_credit_id, 'self revoke attempt');
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (t-2) FAILED: expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (t-2) PASS: non-admin admin_revoke_credit rejected (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (t-3): admin_revoke_credit — double-revoke rejected (22023)
-- ---------------------------------------------------------------------------
-- WHY: Forward-only state machine. Revoking an already-revoked credit must
-- raise 22023 — admins must issue a new credit if they change their mind
-- (creating a fresh audit row for the re-issuance). This test ensures the
-- bidirectional loop (revoke → un-revoke → revoke) is impossible.
-- SOC2 CC9.2: Audit trail for credits is linear; no back-edges in state machine.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID    := gen_random_uuid();
  v_owner     UUID    := gen_random_uuid();
  v_credit_id bigint;
  v_caught    BOOLEAN := FALSE;
  v_code      text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_t3@bops.test', 'x', now(), now()),
    (v_owner, 'owner_t3@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed t3');

  SELECT _rls_seed_credit(v_owner, v_admin) INTO v_credit_id;

  -- First revoke — must succeed
  PERFORM _rls_test_impersonate(v_admin);
  PERFORM public.admin_revoke_credit(v_credit_id, 'first revoke');

  -- Second revoke — must raise 22023
  BEGIN
    PERFORM public.admin_revoke_credit(v_credit_id, 'double revoke attempt');
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (t-3) FAILED: double-revoke expected 22023, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (t-3) PASS: double-revoke rejected (22023)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (t-4): admin_revoke_credit — applied credit cannot be revoked (22023)
-- ---------------------------------------------------------------------------
-- WHY: An applied credit represents a completed financial transaction — revoking
-- it is semantically meaningless and could mislead auditors. The function must
-- reject revocation of any credit where applied_at IS NOT NULL.
-- SOC2 CC9.2: Completed financial transactions cannot be silently rolled back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID    := gen_random_uuid();
  v_owner     UUID    := gen_random_uuid();
  v_credit_id bigint;
  v_caught    BOOLEAN := FALSE;
  v_code      text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_t4@bops.test', 'x', now(), now()),
    (v_owner, 'owner_t4@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed t4');

  -- Seed a credit and mark it applied (simulating Polar webhook applying it)
  SELECT _rls_seed_credit(v_owner, v_admin) INTO v_credit_id;
  UPDATE public.billing_credits
    SET applied_at = now(), applied_to_polar_invoice_id = 'inv_t4_001'
    WHERE id = v_credit_id;

  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    PERFORM public.admin_revoke_credit(v_credit_id, 'revoke applied credit attempt');
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (t-4) FAILED: applied credit revoke expected 22023, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (t-4) PASS: applied credit revocation rejected (22023)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- admin_send_churn_save_offer tests (migration 051) ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (u-1): admin_send_churn_save_offer happy path — returns (audit_id, offer_id)
-- ---------------------------------------------------------------------------
-- WHY: Baseline success path. Admin sends an offer; churn_save_offers row is
-- inserted with server-derived pct + duration; audit row is written.
-- Verifies server-side kind derivation is correct for both offer kinds.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin    UUID   := gen_random_uuid();
  v_target   UUID   := gen_random_uuid();
  v_audit_id bigint;
  v_offer_id bigint;
  v_pct      int;
  v_dur      int;
  v_aud_cnt  int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_u1@bops.test',  'x', now(), now()),
    (v_target, 'target_u1@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed u1');

  PERFORM _rls_test_impersonate(v_admin);
  SELECT r.audit_id, r.offer_id
    INTO v_audit_id, v_offer_id
    FROM public.admin_send_churn_save_offer(
      v_target, 'annual_3mo_25pct', 'test offer u1', NULL
    ) r;
  PERFORM _rls_test_reset_role();

  IF v_audit_id IS NULL OR v_audit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (u-1) FAILED: expected positive audit_id, got %', v_audit_id;
  END IF;
  IF v_offer_id IS NULL OR v_offer_id <= 0 THEN
    RAISE EXCEPTION 'TEST (u-1) FAILED: expected positive offer_id, got %', v_offer_id;
  END IF;

  -- Verify server-side derivation: annual_3mo_25pct → pct=25, duration=3
  SELECT discount_pct, discount_duration_months
    INTO v_pct, v_dur
    FROM public.churn_save_offers WHERE id = v_offer_id;

  IF v_pct <> 25 OR v_dur <> 3 THEN
    RAISE EXCEPTION 'TEST (u-1) FAILED: expected pct=25 dur=3, got pct=% dur=%', v_pct, v_dur;
  END IF;

  SELECT count(*) INTO v_aud_cnt
    FROM public.admin_audit_log
    WHERE id = v_audit_id AND action = 'churn_save_sent' AND target_user_id = v_target;

  IF v_aud_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST (u-1) FAILED: expected 1 churn_save_sent audit row, got %', v_aud_cnt;
  END IF;

  RAISE NOTICE 'TEST (u-1) PASS: admin_send_churn_save_offer happy path (annual_3mo_25pct), audit_id=%, offer_id=%', v_audit_id, v_offer_id;
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (u-2): admin_send_churn_save_offer — non-admin gets 42501
-- ---------------------------------------------------------------------------
-- WHY: An authenticated non-admin must not be able to create churn-save offers.
-- Creating an unauthorized offer could give a user an unapproved discount.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user   UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_user,   'user_u2@bops.test',   'x', now(), now()),
    (v_target, 'target_u2@bops.test', 'x', now(), now());

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    PERFORM public.admin_send_churn_save_offer(v_target, 'monthly_1mo_50pct', 'unauthorized', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (u-2) FAILED: expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (u-2) PASS: non-admin admin_send_churn_save_offer rejected (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (u-3): admin_send_churn_save_offer — active-offer-exists rejection (22023)
-- ---------------------------------------------------------------------------
-- WHY: Sending the same offer kind to a user who already has an active (unexpired,
-- not accepted, not revoked) offer must be rejected. This prevents accidental
-- multi-send spam and ensures each active offer is unique per (user, kind).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin  UUID    := gen_random_uuid();
  v_target UUID    := gen_random_uuid();
  v_caught BOOLEAN := FALSE;
  v_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,  'admin_u3@bops.test',  'x', now(), now()),
    (v_target, 'target_u3@bops.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed u3');

  PERFORM _rls_test_impersonate(v_admin);

  -- First offer — must succeed
  PERFORM public.admin_send_churn_save_offer(v_target, 'annual_3mo_25pct', 'first offer', NULL);

  -- Second offer of the same kind — must raise 22023 (active offer exists)
  BEGIN
    PERFORM public.admin_send_churn_save_offer(v_target, 'annual_3mo_25pct', 'duplicate offer', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (u-3) FAILED: active offer exists expected 22023, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (u-3) PASS: duplicate active offer rejected (22023)';
END;
$$;

ROLLBACK;

-- ============================================================================
-- ---- user_accept_churn_save_offer tests (migration 051) ----
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test (v-1): user_accept_churn_save_offer happy path — accepted_at set
-- ---------------------------------------------------------------------------
-- WHY: Baseline success path. User accepts their own active offer; accepted_at
-- is set; audit row written with actor_id = user (not admin).
-- GDPR Art.7: Affirmative consent recorded with timestamp.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin    UUID   := gen_random_uuid();
  v_user     UUID   := gen_random_uuid();
  v_offer_id bigint;
  v_audit_id bigint;
  v_acc_at   timestamptz;
  v_actor    uuid;
  v_aud_cnt  int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_v1@bops.test', 'x', now(), now()),
    (v_user,  'user_v1@bops.test',  'x', now(), now());

  -- Seed an active offer for v_user
  SELECT _rls_seed_offer(v_user, v_admin) INTO v_offer_id;

  PERFORM _rls_test_impersonate(v_user);
  SELECT public.user_accept_churn_save_offer(v_offer_id) INTO v_audit_id;
  PERFORM _rls_test_reset_role();

  IF v_audit_id IS NULL OR v_audit_id <= 0 THEN
    RAISE EXCEPTION 'TEST (v-1) FAILED: expected positive audit_id, got %', v_audit_id;
  END IF;

  -- Verify accepted_at is set
  SELECT accepted_at INTO v_acc_at
    FROM public.churn_save_offers WHERE id = v_offer_id;

  IF v_acc_at IS NULL THEN
    RAISE EXCEPTION 'TEST (v-1) FAILED: accepted_at not set on churn_save_offers row';
  END IF;

  -- Verify audit actor_id is the user (not the admin) — GDPR Art.7 consent record
  SELECT actor_id INTO v_actor
    FROM public.admin_audit_log
    WHERE id = v_audit_id AND action = 'churn_save_accepted';

  IF v_actor <> v_user THEN
    RAISE EXCEPTION 'TEST (v-1) FAILED: audit actor_id is % but expected %', v_actor, v_user;
  END IF;

  RAISE NOTICE 'TEST (v-1) PASS: user_accept_churn_save_offer happy path, audit_id=%', v_audit_id;
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (v-2): user_accept_churn_save_offer — other user's offer returns 42501
-- ---------------------------------------------------------------------------
-- WHY: A user must not be able to accept an offer that belongs to a different
-- user. This tests the ownership check (offer.user_id = auth.uid()) inside the
-- SECURITY DEFINER body. Without this test a regression removing the ownership
-- check would allow cross-user offer acceptance (broken access control).
-- OWASP A01:2021: Confused deputy / cross-user data access prevented.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin      UUID    := gen_random_uuid();
  v_owner      UUID    := gen_random_uuid();
  v_stranger   UUID    := gen_random_uuid();
  v_offer_id   bigint;
  v_caught     BOOLEAN := FALSE;
  v_code       text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin,    'admin_v2@bops.test',   'x', now(), now()),
    (v_owner,    'owner_v2@bops.test',   'x', now(), now()),
    (v_stranger, 'strange_v2@bops.test', 'x', now(), now());

  -- Offer belongs to v_owner
  SELECT _rls_seed_offer(v_owner, v_admin) INTO v_offer_id;

  -- Stranger attempts to accept it — must raise 42501
  PERFORM _rls_test_impersonate(v_stranger);
  BEGIN
    PERFORM public.user_accept_churn_save_offer(v_offer_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (v-2) FAILED: cross-user accept expected 42501, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (v-2) PASS: cross-user user_accept_churn_save_offer rejected (42501)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (v-3): user_accept_churn_save_offer — expired offer rejected (22023)
-- ---------------------------------------------------------------------------
-- WHY: A user who sees an offer notification but waits past the 7-day window
-- must be rejected with 22023. An expired offer cannot be accepted; the admin
-- would need to send a new offer. This test simulates expiry by direct UPDATE
-- of expires_at to the past (allowed at superuser level for test fixtures).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin    UUID    := gen_random_uuid();
  v_user     UUID    := gen_random_uuid();
  v_offer_id bigint;
  v_caught   BOOLEAN := FALSE;
  v_code     text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_v3@bops.test', 'x', now(), now()),
    (v_user,  'user_v3@bops.test',  'x', now(), now());

  SELECT _rls_seed_offer(v_user, v_admin) INTO v_offer_id;

  -- Force-expire the offer (superuser UPDATE bypasses RLS — test fixture only)
  UPDATE public.churn_save_offers
    SET expires_at = now() - interval '1 second'
    WHERE id = v_offer_id;

  PERFORM _rls_test_impersonate(v_user);
  BEGIN
    PERFORM public.user_accept_churn_save_offer(v_offer_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (v-3) FAILED: expired offer expected 22023, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (v-3) PASS: expired offer acceptance rejected (22023)';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (v-4): user_accept_churn_save_offer — already-accepted offer rejected (22023)
-- ---------------------------------------------------------------------------
-- WHY: An offer can only be accepted once (accepted_at is a terminal state).
-- A second acceptance attempt — e.g. from a duplicate mobile tap or a retry loop
-- — must be rejected with 22023. This prevents double-counting and ensures the
-- audit trail has exactly one 'churn_save_accepted' row per offer.
-- SOC2 CC9.2: State machine forward-only; no re-acceptance of terminal offers.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin    UUID    := gen_random_uuid();
  v_user     UUID    := gen_random_uuid();
  v_offer_id bigint;
  v_caught   BOOLEAN := FALSE;
  v_code     text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at) VALUES
    (v_admin, 'admin_v4@bops.test', 'x', now(), now()),
    (v_user,  'user_v4@bops.test',  'x', now(), now());

  SELECT _rls_seed_offer(v_user, v_admin) INTO v_offer_id;

  PERFORM _rls_test_impersonate(v_user);

  -- First accept — must succeed
  PERFORM public.user_accept_churn_save_offer(v_offer_id);

  -- Second accept — must raise 22023
  BEGIN
    PERFORM public.user_accept_churn_save_offer(v_offer_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (v-4) FAILED: re-accept expected 22023, got caught=% code=%', v_caught, v_code;
  END IF;

  RAISE NOTICE 'TEST (v-4) PASS: re-acceptance of already-accepted offer rejected (22023)';
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
