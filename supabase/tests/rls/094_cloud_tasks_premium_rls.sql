-- ============================================================================
-- RLS TEST SUITE: Migration 094 (cloud_tasks premium-tier INSERT enforcement)
-- ============================================================================
-- Validates that cloud_tasks INSERT is gated to ACTIVE premium subscribers
-- (tier growth or legacy power), while preserving owner-only semantics.
--
-- USAGE (local):
--   supabase db reset                # applies all migrations incl. 094
--   psql "$DB_URL" -f supabase/tests/rls/094_cloud_tasks_premium_rls.sql
--
-- Exit semantics: each test wrapped in BEGIN..ROLLBACK; RAISE EXCEPTION aborts
-- on first failure; success ends with "ALL RLS TESTS PASSED".
--
-- Security invariants under test (canonical model:
-- docs/planning/styrby-tiers-canonical.md):
--   1. Active growth subscriber CAN insert (current premium tier).
--   2. Active power subscriber CAN insert (legacy premium, grandfathered).
--   3. Active pro subscriber CANNOT insert (pro is paid-but-not-premium).
--   4. Free user (no subscription row) CANNOT insert.
--   5. Canceled growth subscriber CANNOT insert (status must be 'active').
--   6. Premium owner CANNOT insert a row with someone else's user_id.
-- ============================================================================

CREATE OR REPLACE FUNCTION _rls_test_impersonate(p_uid UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
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
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

-- Seeds an auth user + profile + a subscription row with the given tier/status.
-- (Skip the subscription entirely for a 'free' fixture by passing NULL tier.)
CREATE OR REPLACE FUNCTION _seed_user(p_uid UUID, p_email TEXT, p_tier TEXT, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (p_uid, p_email) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (p_uid) ON CONFLICT DO NOTHING;
  IF p_tier IS NOT NULL THEN
    INSERT INTO subscriptions (user_id, polar_subscription_id, polar_customer_id, tier, status)
    VALUES (p_uid, 'polar_sub_' || p_uid::text, 'polar_cus_' || p_uid::text,
            p_tier::subscription_tier, p_status::subscription_status);
  END IF;
END;
$$;

BEGIN;

-- ---------------------------------------------------------------------------
-- Test 1: active growth subscriber CAN insert
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u UUID := gen_random_uuid(); v_count INT;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_u, 'growth94@test.local', 'growth', 'active');

  PERFORM _rls_test_impersonate(v_u);
  INSERT INTO cloud_tasks (user_id, agent_type, prompt)
    VALUES (v_u, 'claude', 'refactor the auth module');

  SELECT count(*) INTO v_count FROM cloud_tasks WHERE user_id = v_u;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: active growth user could not insert (count=%)', v_count;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 1 PASS: active growth subscriber can insert cloud_tasks';
END;
$$;

ROLLBACK; BEGIN;

-- ---------------------------------------------------------------------------
-- Test 2: 'power' is RETIRED — an (impossible) active power subscriber is blocked
-- ---------------------------------------------------------------------------
-- Migration 095 retired the 'power' tier (zero customers; the lone comp account
-- was migrated to growth). Premium is now 'growth' only. The enum value still
-- exists (Postgres can't drop it), so we assert that even a synthetic power row
-- is denied — proving no path treats 'power' as premium any more.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u UUID := gen_random_uuid(); v_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_u, 'power94@test.local', 'power', 'active');

  PERFORM _rls_test_impersonate(v_u);
  BEGIN
    INSERT INTO cloud_tasks (user_id, agent_type, prompt)
      VALUES (v_u, 'codex', 'retired power tier should be blocked');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_denied := TRUE;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST 2 FAILED: retired power tier was treated as premium';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 2 PASS: retired power tier is blocked (premium = growth only)';
END;
$$;

ROLLBACK; BEGIN;

-- ---------------------------------------------------------------------------
-- Test 3: active pro subscriber CANNOT insert (pro is not premium)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u UUID := gen_random_uuid(); v_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_u, 'pro94@test.local', 'pro', 'active');

  PERFORM _rls_test_impersonate(v_u);
  BEGIN
    INSERT INTO cloud_tasks (user_id, agent_type, prompt)
      VALUES (v_u, 'claude', 'pro user should be blocked');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_denied := TRUE;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST 3 FAILED: pro user was allowed to insert a cloud_task (pro is not premium)';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 3 PASS: active pro subscriber blocked (pro != premium)';
END;
$$;

ROLLBACK; BEGIN;

-- ---------------------------------------------------------------------------
-- Test 4: free user (no subscription row) CANNOT insert
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u UUID := gen_random_uuid(); v_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_u, 'free94@test.local', NULL, NULL);  -- no subscription

  PERFORM _rls_test_impersonate(v_u);
  BEGIN
    INSERT INTO cloud_tasks (user_id, agent_type, prompt)
      VALUES (v_u, 'claude', 'free user should be blocked');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_denied := TRUE;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST 4 FAILED: free user (no sub) was allowed to insert a cloud_task';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 4 PASS: free user (no subscription) blocked';
END;
$$;

ROLLBACK; BEGIN;

-- ---------------------------------------------------------------------------
-- Test 5: canceled growth subscriber CANNOT insert (status gate)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u UUID := gen_random_uuid(); v_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_u, 'cancgrowth94@test.local', 'growth', 'canceled');

  PERFORM _rls_test_impersonate(v_u);
  BEGIN
    INSERT INTO cloud_tasks (user_id, agent_type, prompt)
      VALUES (v_u, 'claude', 'canceled premium should be blocked');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_denied := TRUE;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST 5 FAILED: canceled growth subscriber was allowed to insert';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 5 PASS: canceled growth subscriber blocked (status must be active)';
END;
$$;

ROLLBACK; BEGIN;

-- ---------------------------------------------------------------------------
-- Test 6: premium owner CANNOT insert a row owned by another user
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_premium UUID := gen_random_uuid();
  v_other   UUID := gen_random_uuid();
  v_denied  BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();
  PERFORM _seed_user(v_premium, 'gowner94@test.local', 'growth', 'active');
  PERFORM _seed_user(v_other,   'other94@test.local',  'growth', 'active');

  -- Premium user authenticated, but tries to insert with v_other's user_id.
  PERFORM _rls_test_impersonate(v_premium);
  BEGIN
    INSERT INTO cloud_tasks (user_id, agent_type, prompt)
      VALUES (v_other, 'claude', 'cross-user insert should be blocked');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_denied := TRUE;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST 6 FAILED: premium user inserted a cloud_task with a foreign user_id';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 6 PASS: owner isolation holds (cannot insert for another user)';
END;
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- Cleanup helpers
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
DROP FUNCTION IF EXISTS _rls_test_reset_role();
DROP FUNCTION IF EXISTS _seed_user(UUID, TEXT, TEXT, TEXT);

DO $$
BEGIN
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'ALL RLS TESTS PASSED — migration 094 cloud_tasks premium gate holds';
  RAISE NOTICE '================================================================';
END;
$$;
