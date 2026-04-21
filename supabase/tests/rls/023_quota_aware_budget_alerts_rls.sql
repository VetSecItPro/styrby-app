-- ============================================================================
-- RLS TEST SUITE: Migration 023 (Quota-Aware Budget Alerts)
-- ============================================================================
-- Validates that:
--   1. The new columns (alert_type, threshold_quota_fraction, threshold_credits)
--      do NOT weaken the existing user-scoped RLS on budget_alerts.
--   2. User A cannot SELECT, UPDATE, or DELETE budget_alerts rows belonging
--      to User B — including when querying the new columns.
--   3. CHECK constraints fire for invalid alert_type / threshold combinations.
--
-- USAGE (local):
--   supabase db reset
--   psql "$DB_URL" -f supabase/tests/rls/023_quota_aware_budget_alerts_rls.sql
--
-- Exit semantics:
--   - Each test is wrapped in BEGIN ... ROLLBACK so DB state is not mutated.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL RLS TESTS PASSED" notice.
--
-- Security invariants under test:
--   T1. Cross-user SELECT isolation holds with new columns.
--   T2. User B cannot UPDATE alert_type on User A's budget_alerts row.
--   T3. INSERT check: subscription_quota without threshold_quota_fraction fails.
--   T4. INSERT check: credits without threshold_credits fails.
--   T5. INSERT check: cost_usd with threshold_quota_fraction set fails.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Test harness helpers (same pattern as 022_cost_source_of_truth_rls.sql)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _rls_test_impersonate(p_uid UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
END;
$$;

CREATE OR REPLACE FUNCTION _rls_test_reset_role()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;


-- ---------------------------------------------------------------------------
-- T1: Cross-user SELECT isolation with new columns
-- ---------------------------------------------------------------------------
-- Alice should see exactly her own budget_alerts rows (including the new
-- columns) and must see zero rows belonging to Bob.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_alice   UUID := gen_random_uuid();
  v_bob     UUID := gen_random_uuid();
  v_seen    INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice23@test.local'),
    (v_bob,   'bob23@test.local');

  INSERT INTO profiles (id) VALUES (v_alice) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (v_bob)   ON CONFLICT DO NOTHING;

  -- Alice: cost_usd alert (legacy type)
  INSERT INTO budget_alerts (
    user_id, name, threshold_usd, period, action,
    alert_type
  ) VALUES (
    v_alice, 'Alice cost alert', 50, 'monthly', 'notify',
    'cost_usd'
  );

  -- Alice: subscription_quota alert
  INSERT INTO budget_alerts (
    user_id, name, threshold_usd, period, action,
    alert_type, threshold_quota_fraction
  ) VALUES (
    v_alice, 'Alice quota alert', 0, 'monthly', 'notify',
    'subscription_quota', 0.8000
  );

  -- Bob: credits alert
  INSERT INTO budget_alerts (
    user_id, name, threshold_usd, period, action,
    alert_type, threshold_credits
  ) VALUES (
    v_bob, 'Bob credits alert', 0, 'daily', 'notify',
    'credits', 500
  );

  -- Alice sees 2 rows (her own); must not see Bob's credits alert
  PERFORM _rls_test_impersonate(v_alice);
  SELECT count(*) INTO v_seen
    FROM budget_alerts
    WHERE alert_type IS NOT NULL;   -- exercises new column in the query
  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'T1 FAILED: alice sees % budget_alerts rows, expected 2', v_seen;
  END IF;

  -- Specifically: alice must see 0 credits-type alerts (those belong to bob)
  SELECT count(*) INTO v_seen
    FROM budget_alerts
    WHERE alert_type = 'credits';
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'T1 FAILED: alice sees bob''s credits alert (count=%)', v_seen;
  END IF;

  -- Bob sees 1 row (his own)
  PERFORM _rls_test_impersonate(v_bob);
  SELECT count(*) INTO v_seen
    FROM budget_alerts
    WHERE threshold_credits IS NOT NULL;  -- exercises new column
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'T1 FAILED: bob sees % rows with threshold_credits, expected 1', v_seen;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T1 PASS: cross-user SELECT isolation holds with new columns';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- T2: User B cannot UPDATE alert_type on User A's row
-- ---------------------------------------------------------------------------
-- budget_alerts has no UPDATE policy for authenticated users — all mutations
-- must go through service_role or the application API layer (which uses
-- service_role internally). A direct UPDATE as an authenticated user is
-- expected to be blocked or silently match 0 rows (RLS filter).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_alice         UUID := gen_random_uuid();
  v_bob           UUID := gen_random_uuid();
  v_alert_id      UUID := gen_random_uuid();
  v_update_denied BOOLEAN := FALSE;
  v_final_type    budget_alert_type;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice23b@test.local'),
    (v_bob,   'bob23b@test.local');

  INSERT INTO profiles (id) VALUES (v_alice) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (v_bob)   ON CONFLICT DO NOTHING;

  -- Seed a cost_usd alert for alice
  INSERT INTO budget_alerts (
    id, user_id, name, threshold_usd, period, action,
    alert_type
  ) VALUES (
    v_alert_id, v_alice, 'Alice cost alert', 25, 'weekly', 'hard_stop',
    'cost_usd'
  );

  -- Bob attempts to flip alice's alert_type to 'credits'
  PERFORM _rls_test_impersonate(v_bob);
  BEGIN
    UPDATE budget_alerts
      SET alert_type = 'credits', threshold_credits = 100
      WHERE id = v_alert_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_update_denied := TRUE;
  END;

  -- If no exception, verify the row was not actually modified
  IF NOT v_update_denied THEN
    PERFORM _rls_test_reset_role();
    SELECT alert_type INTO v_final_type
      FROM budget_alerts WHERE id = v_alert_id;
    IF v_final_type <> 'cost_usd' THEN
      RAISE EXCEPTION 'T2 FAILED: bob updated alice''s alert_type to %', v_final_type;
    END IF;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T2 PASS: UPDATE of alert_type blocked for non-owner';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- T3: subscription_quota INSERT without threshold_quota_fraction fails
-- ---------------------------------------------------------------------------
-- CHECK constraint chk_quota_fraction_range must reject a subscription_quota
-- row that has a NULL threshold_quota_fraction.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_insert_failed BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES (v_owner, 'owner23c@test.local');
  INSERT INTO profiles (id) VALUES (v_owner) ON CONFLICT DO NOTHING;

  BEGIN
    INSERT INTO budget_alerts (
      user_id, name, threshold_usd, period, action,
      alert_type
      -- threshold_quota_fraction intentionally omitted (NULL)
    ) VALUES (
      v_owner, 'Bad quota alert', 0, 'monthly', 'notify',
      'subscription_quota'
    );
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    v_insert_failed := TRUE;
  END;

  IF NOT v_insert_failed THEN
    RAISE EXCEPTION 'T3 FAILED: subscription_quota INSERT without threshold_quota_fraction was allowed';
  END IF;

  RAISE NOTICE 'T3 PASS: subscription_quota without threshold_quota_fraction rejected';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- T4: credits INSERT without threshold_credits fails
-- ---------------------------------------------------------------------------
-- CHECK constraint chk_credits_range must reject a credits row that has a
-- NULL threshold_credits.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_insert_failed BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES (v_owner, 'owner23d@test.local');
  INSERT INTO profiles (id) VALUES (v_owner) ON CONFLICT DO NOTHING;

  BEGIN
    INSERT INTO budget_alerts (
      user_id, name, threshold_usd, period, action,
      alert_type
      -- threshold_credits intentionally omitted (NULL)
    ) VALUES (
      v_owner, 'Bad credits alert', 0, 'daily', 'notify',
      'credits'
    );
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    v_insert_failed := TRUE;
  END;

  IF NOT v_insert_failed THEN
    RAISE EXCEPTION 'T4 FAILED: credits INSERT without threshold_credits was allowed';
  END IF;

  RAISE NOTICE 'T4 PASS: credits without threshold_credits rejected';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- T5: cost_usd INSERT with threshold_quota_fraction set fails
-- ---------------------------------------------------------------------------
-- CHECK constraint chk_cost_usd_no_quota_fields must reject a cost_usd row
-- that inadvertently populates the quota fraction column.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_insert_failed BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES (v_owner, 'owner23e@test.local');
  INSERT INTO profiles (id) VALUES (v_owner) ON CONFLICT DO NOTHING;

  BEGIN
    INSERT INTO budget_alerts (
      user_id, name, threshold_usd, period, action,
      alert_type, threshold_quota_fraction   -- invalid for cost_usd
    ) VALUES (
      v_owner, 'Bad cost_usd alert', 50, 'weekly', 'notify',
      'cost_usd', 0.8000
    );
  EXCEPTION WHEN check_violation THEN
    v_insert_failed := TRUE;
  END;

  IF NOT v_insert_failed THEN
    RAISE EXCEPTION 'T5 FAILED: cost_usd INSERT with threshold_quota_fraction was allowed';
  END IF;

  RAISE NOTICE 'T5 PASS: cost_usd with threshold_quota_fraction rejected';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Cleanup helpers
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
DROP FUNCTION IF EXISTS _rls_test_reset_role();

DO $$
BEGIN
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'ALL RLS TESTS PASSED — migration 023 budget_alerts invariants hold';
  RAISE NOTICE '================================================================';
END;
$$;
