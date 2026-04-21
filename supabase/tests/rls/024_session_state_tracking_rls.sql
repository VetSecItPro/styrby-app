-- ============================================================================
-- RLS TEST SUITE: Migration 024 (Session State Tracking)
-- ============================================================================
-- Validates that the new last_seen_at column does NOT weaken the existing
-- user-scoped RLS on sessions established in migration 001.
--
-- Security invariants under test:
--   T1. Cross-user SELECT: Alice cannot read last_seen_at on Bob's sessions.
--   T2. Cross-user UPDATE: Bob cannot write last_seen_at on Alice's sessions.
--   T3. Cross-user UPDATE via updateState pattern: Bob cannot set status+last_seen_at
--       on Alice's sessions (the exact SQL that SessionStorage.updateState() emits).
--   T4. Cross-user INSERT: Bob cannot INSERT a session row with last_seen_at
--       pointing at Alice's user_id.
--   T5. Own-user UPDATE allowed: Alice CAN update last_seen_at on her own session.
--
-- USAGE (local):
--   supabase db reset
--   psql "$DB_URL" -f supabase/tests/rls/024_session_state_tracking_rls.sql
--
-- Exit semantics:
--   - Each test is wrapped in BEGIN ... ROLLBACK so DB state is not mutated.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL RLS TESTS PASSED" notice.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Test harness helpers (same pattern as 022, 023)
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
-- Seed: two users, two profiles, two machines, two sessions
-- ---------------------------------------------------------------------------
-- Each test block rolls back, so we insert the seed data inside a setup
-- transaction that is shared only within this script's scope.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  alice_id   UUID := gen_random_uuid();
  bob_id     UUID := gen_random_uuid();
  machine_a  UUID := gen_random_uuid();
  machine_b  UUID := gen_random_uuid();
  session_a  UUID := gen_random_uuid();
  session_b  UUID := gen_random_uuid();
BEGIN
  -- Insert auth users (postgres role, bypasses RLS)
  INSERT INTO auth.users (id, email)
    VALUES (alice_id, 'alice-024@test.local'),
           (bob_id,   'bob-024@test.local');

  -- Profiles are auto-created by trigger; verify they exist
  -- (trigger is set in migration 001)

  -- Machines
  INSERT INTO machines (id, user_id, name, platform, is_online)
    VALUES (machine_a, alice_id, 'alice-mac',  'darwin', false),
           (machine_b, bob_id,   'bob-mac',    'darwin', false);

  -- Sessions
  INSERT INTO sessions (id, user_id, machine_id, agent_type, status,
                        last_seen_at, last_activity_at)
    VALUES
      (session_a, alice_id, machine_a, 'claude', 'running',
       now() - interval '2 minutes', now() - interval '2 minutes'),
      (session_b, bob_id,   machine_b, 'claude', 'running',
       now() - interval '5 minutes', now() - interval '5 minutes');

  -- Store IDs in session-level settings for test blocks to read
  PERFORM set_config('test024.alice_id',  alice_id::text,  false);
  PERFORM set_config('test024.bob_id',    bob_id::text,    false);
  PERFORM set_config('test024.session_a', session_a::text, false);
  PERFORM set_config('test024.session_b', session_b::text, false);
END;
$$;


-- ---------------------------------------------------------------------------
-- T1: Cross-user SELECT — Alice cannot read Bob's last_seen_at
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  alice_id  UUID := current_setting('test024.alice_id')::UUID;
  session_b UUID := current_setting('test024.session_b')::UUID;
  row_count INTEGER;
BEGIN
  PERFORM _rls_test_impersonate(alice_id);

  SELECT COUNT(*) INTO row_count
    FROM sessions
    WHERE id = session_b;

  IF row_count <> 0 THEN
    RAISE EXCEPTION 'T1 FAIL: Alice read % rows for Bob''s session (expected 0)', row_count;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T1 PASS: Alice cannot SELECT Bob''s session (including last_seen_at)';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- T2: Cross-user UPDATE last_seen_at — Bob cannot write Alice's session
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  bob_id    UUID := current_setting('test024.bob_id')::UUID;
  session_a UUID := current_setting('test024.session_a')::UUID;
  rows_affected INTEGER;
BEGIN
  PERFORM _rls_test_impersonate(bob_id);

  UPDATE sessions
    SET last_seen_at = now()
    WHERE id = session_a;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected <> 0 THEN
    RAISE EXCEPTION 'T2 FAIL: Bob updated % rows on Alice''s session (expected 0)', rows_affected;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T2 PASS: Bob cannot UPDATE last_seen_at on Alice''s session';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- T3: updateState pattern — Bob cannot set status + last_seen_at on Alice's session
-- This replicates the exact UPDATE query that SessionStorage.updateState() emits.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  bob_id    UUID := current_setting('test024.bob_id')::UUID;
  session_a UUID := current_setting('test024.session_a')::UUID;
  rows_affected INTEGER;
BEGIN
  PERFORM _rls_test_impersonate(bob_id);

  UPDATE sessions
    SET status       = 'paused',
        last_seen_at = now(),
        last_activity_at = now()
    WHERE id = session_a;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected <> 0 THEN
    RAISE EXCEPTION 'T3 FAIL: Bob updateState''d % rows on Alice''s session (expected 0)',
      rows_affected;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T3 PASS: Bob cannot run updateState pattern on Alice''s session';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- T4: Cross-user INSERT with last_seen_at — Bob cannot INSERT for Alice
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  bob_id    UUID := current_setting('test024.bob_id')::UUID;
  alice_id  UUID := current_setting('test024.alice_id')::UUID;
  machine_a UUID;
BEGIN
  -- Fetch Alice's machine_id (needed for the FK)
  SELECT id INTO machine_a FROM machines WHERE user_id = alice_id LIMIT 1;

  PERFORM _rls_test_impersonate(bob_id);

  BEGIN
    INSERT INTO sessions (user_id, machine_id, agent_type, status, last_seen_at)
      VALUES (alice_id, machine_a, 'claude', 'running', now());

    -- If we reach here, the insert was not blocked — test failure
    RAISE EXCEPTION 'T4 FAIL: Bob inserted a session row for Alice (should have been blocked)';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL; -- Expected: RLS or FK blocked the insert
  END;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T4 PASS: Bob cannot INSERT a session row for Alice with last_seen_at set';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- T5: Own-user UPDATE allowed — Alice CAN update her own last_seen_at
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  alice_id  UUID := current_setting('test024.alice_id')::UUID;
  session_a UUID := current_setting('test024.session_a')::UUID;
  rows_affected INTEGER;
  new_ts    TIMESTAMPTZ := now();
BEGIN
  PERFORM _rls_test_impersonate(alice_id);

  UPDATE sessions
    SET status       = 'paused',
        last_seen_at = new_ts,
        last_activity_at = new_ts
    WHERE id = session_a;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected <> 1 THEN
    RAISE EXCEPTION 'T5 FAIL: Alice updated % rows on her own session (expected 1)', rows_affected;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'T5 PASS: Alice can UPDATE last_seen_at on her own session';
END;
$$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Cleanup seed data (postgres role)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice_id UUID := current_setting('test024.alice_id')::UUID;
  bob_id   UUID := current_setting('test024.bob_id')::UUID;
BEGIN
  DELETE FROM auth.users WHERE id IN (alice_id, bob_id);
  DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
  DROP FUNCTION IF EXISTS _rls_test_reset_role();
END;
$$;

DO $$ BEGIN
  RAISE NOTICE '=== ALL RLS TESTS PASSED (024_session_state_tracking) ===';
END $$;
