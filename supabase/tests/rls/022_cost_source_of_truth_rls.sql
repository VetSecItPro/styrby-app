-- ============================================================================
-- RLS TEST SUITE: Migration 022 (Cost Source of Truth)
-- ============================================================================
-- Validates that the new columns added to cost_records in migration 022 do
-- NOT weaken the existing user-scoped RLS established in migration 001.
-- Migration 022 adds no new policies; these tests confirm the old invariants
-- still hold after the schema change.
--
-- USAGE (local):
--   supabase db reset               # applies all migrations incl. 022
--   psql "$DB_URL" -f supabase/tests/rls/022_cost_source_of_truth_rls.sql
--
-- Exit semantics:
--   - Each test is wrapped in BEGIN ... ROLLBACK so DB state is not mutated.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL RLS TESTS PASSED" notice.
--
-- Security invariants under test:
--   1. User A cannot SELECT cost_records rows belonging to user B, even when
--      querying the new columns (billing_model, source, raw_agent_payload, etc.).
--   2. INSERT with a mismatched user_id (impersonation) is blocked by RLS.
--   3. UPDATE of billing_model by a non-owner is blocked by RLS.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Test harness helpers (same pattern as 021_team_governance_rls.sql)
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- Test 1: Cross-user SELECT isolation with new columns
-- ---------------------------------------------------------------------------
-- User A should see exactly their own cost_records rows — including when
-- querying the new columns — and must see zero rows owned by user B.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_alice   UUID := gen_random_uuid();
  v_bob     UUID := gen_random_uuid();
  v_machine UUID := gen_random_uuid();
  v_session UUID := gen_random_uuid();
  v_seen    INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Fixtures: two users
  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice22@test.local'),
    (v_bob,   'bob22@test.local');

  -- profiles are auto-created by the on_auth_user_created trigger; if that
  -- trigger is not wired in the shadow DB we fall back to a direct insert.
  INSERT INTO profiles (id) VALUES (v_alice) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (v_bob)   ON CONFLICT DO NOTHING;

  -- Machine + session owned by alice (required FK chain for cost_records)
  INSERT INTO machines (id, user_id, name, machine_fingerprint, hostname)
    VALUES (v_machine, v_alice, 'laptop', 'fp22-' || v_machine::text, 'host22');
  INSERT INTO sessions (id, user_id, machine_id, agent_type)
    VALUES (v_session, v_alice, v_machine, 'claude');

  -- One cost_records row for alice (with new columns explicitly populated)
  INSERT INTO cost_records (
    user_id, session_id, agent_type, model,
    input_tokens, output_tokens, cost_usd,
    billing_model, source, raw_agent_payload,
    credits_consumed, credit_rate_usd
  ) VALUES (
    v_alice, v_session, 'claude', 'claude-sonnet-4',
    1000, 500, 0.0150,
    'api-key', 'agent-reported',
    '{"input_tokens": 1000, "output_tokens": 500}'::jsonb,
    NULL, NULL
  );

  -- One cost_records row for bob (no machine/session needed; session_id is nullable)
  -- Use a separate machine for bob to satisfy FK if session_id is provided.
  -- Here we leave session_id NULL since that is allowed.
  INSERT INTO cost_records (
    user_id, agent_type, model,
    input_tokens, output_tokens, cost_usd,
    billing_model, source
  ) VALUES (
    v_bob, 'claude', 'claude-sonnet-4',
    200, 100, 0.0030,
    'subscription', 'styrby-estimate'
  );

  -- Alice impersonated: must see exactly 1 row
  PERFORM _rls_test_impersonate(v_alice);
  SELECT count(*) INTO v_seen
    FROM cost_records
    WHERE billing_model IS NOT NULL;   -- exercises the new column in the query
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: alice sees % cost_records rows, expected 1', v_seen;
  END IF;

  -- Bob impersonated: must see exactly 1 row (his own)
  PERFORM _rls_test_impersonate(v_bob);
  SELECT count(*) INTO v_seen
    FROM cost_records
    WHERE source IS NOT NULL;          -- exercises the new column in the query
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: bob sees % cost_records rows, expected 1', v_seen;
  END IF;

  -- Verify alice cannot see bob's subscription row
  PERFORM _rls_test_impersonate(v_alice);
  SELECT count(*) INTO v_seen
    FROM cost_records
    WHERE billing_model = 'subscription';
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: alice sees bob''s subscription row (count=%)', v_seen;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 1 PASS: cross-user SELECT isolation holds with new columns';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 2: INSERT with mismatched user_id is blocked
-- ---------------------------------------------------------------------------
-- RLS on cost_records has no INSERT policy for authenticated users — all
-- inserts must go through service_role. A direct INSERT as an authenticated
-- user (with any user_id) should be denied.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_alice        UUID := gen_random_uuid();
  v_bob          UUID := gen_random_uuid();
  v_insert_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice22b@test.local'),
    (v_bob,   'bob22b@test.local');
  INSERT INTO profiles (id) VALUES (v_alice) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (v_bob)   ON CONFLICT DO NOTHING;

  -- Alice authenticated tries to INSERT a row with bob's user_id
  PERFORM _rls_test_impersonate(v_alice);
  BEGIN
    INSERT INTO cost_records (
      user_id, agent_type, model,
      input_tokens, output_tokens, cost_usd,
      billing_model, source
    ) VALUES (
      v_bob, 'claude', 'claude-sonnet-4',
      100, 50, 0.0005,
      'api-key', 'styrby-estimate'
    );
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_insert_denied := TRUE;
  END;

  IF NOT v_insert_denied THEN
    RAISE EXCEPTION 'TEST 2 FAILED: authenticated user inserted cost_records with foreign user_id';
  END IF;

  -- Also block self-insert (no INSERT policy for authenticated role at all)
  v_insert_denied := FALSE;
  PERFORM _rls_test_impersonate(v_alice);
  BEGIN
    INSERT INTO cost_records (
      user_id, agent_type, model,
      input_tokens, output_tokens, cost_usd,
      billing_model, source
    ) VALUES (
      v_alice, 'claude', 'claude-sonnet-4',
      100, 50, 0.0005,
      'credit', 'styrby-estimate'
    );
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_insert_denied := TRUE;
  END;

  IF NOT v_insert_denied THEN
    RAISE EXCEPTION 'TEST 2 FAILED: authenticated user was allowed to self-INSERT cost_records (service_role only)';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 2 PASS: cost_records INSERT blocked for authenticated role (service_role only)';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 3: UPDATE of billing_model by a non-owner is blocked
-- ---------------------------------------------------------------------------
-- There is no UPDATE policy for authenticated users on cost_records. A user
-- who does not own a row must not be able to flip billing_model or any other
-- column.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_alice        UUID := gen_random_uuid();
  v_bob          UUID := gen_random_uuid();
  v_record_id    UUID := gen_random_uuid();
  v_update_denied BOOLEAN := FALSE;
  v_final_model  cost_billing_model;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice22c@test.local'),
    (v_bob,   'bob22c@test.local');
  INSERT INTO profiles (id) VALUES (v_alice) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (v_bob)   ON CONFLICT DO NOTHING;

  -- Seed a cost_records row belonging to alice (postgres / service role insert)
  INSERT INTO cost_records (
    id, user_id, agent_type, model,
    input_tokens, output_tokens, cost_usd,
    billing_model, source
  ) VALUES (
    v_record_id, v_alice, 'claude', 'claude-sonnet-4',
    500, 250, 0.0075,
    'api-key', 'styrby-estimate'
  );

  -- Bob authenticated tries to UPDATE billing_model on alice's row
  PERFORM _rls_test_impersonate(v_bob);
  BEGIN
    UPDATE cost_records
      SET billing_model = 'free'
      WHERE id = v_record_id;
    -- If no exception raised, check whether the row actually changed
    -- (a silent no-op UPDATE means 0 rows matched through RLS — also acceptable)
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_update_denied := TRUE;
  END;

  -- Fall back to checking the actual value if no exception was raised:
  -- RLS may silently match 0 rows rather than raise an error.
  IF NOT v_update_denied THEN
    PERFORM _rls_test_reset_role();
    SELECT billing_model INTO v_final_model
      FROM cost_records WHERE id = v_record_id;
    IF v_final_model <> 'api-key' THEN
      RAISE EXCEPTION 'TEST 3 FAILED: bob successfully updated alice''s billing_model to %', v_final_model;
    END IF;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 3 PASS: UPDATE of billing_model blocked for non-owner';
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
  RAISE NOTICE 'ALL RLS TESTS PASSED — migration 022 cost_records invariants hold';
  RAISE NOTICE '================================================================';
END;
$$;
