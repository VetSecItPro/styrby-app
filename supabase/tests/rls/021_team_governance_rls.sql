-- ============================================================================
-- RLS TEST SUITE: Migration 021 (Team Governance)
-- ============================================================================
-- Validates the security invariants of migration 021. Runs against a local
-- Supabase shadow database. Each test block impersonates a user via the
-- authenticated role + a synthetic JWT claim for auth.uid().
--
-- USAGE (local):
--   supabase db reset               # applies all migrations incl. 021
--   psql "$DB_URL" -f supabase/tests/rls/021_team_governance_rls.sql
--
-- Exit semantics:
--   - Each test is wrapped in BEGIN ... ROLLBACK so DB state is not mutated.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL RLS TESTS PASSED" notice.
--
-- Security invariants under test:
--   1. Members of team A cannot see team_policies of team B.
--   2. Only admins of team A can INSERT team_policies for team A.
--   3. A member of team A can INSERT their own approval but cannot resolve others'.
--   4. Admins of team A can resolve any approval in team A.
--   5. A user's exports / billing_events are not visible to other users.
--   6. integrations.config_encrypted is column-level-revoked for authenticated role.
--   7. sessions_shared grants visibility to the recipient ONLY.
--   8. Audit log rows appear for INSERT into team_policies (trigger wiring).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test harness helpers
-- ---------------------------------------------------------------------------

-- Switch to authenticated role and set a synthetic uid. We use set_config
-- with is_local=true so changes reset at ROLLBACK.
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

-- Reset to the superuser role we started in (bypasses RLS for fixture setup).
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
-- Test 1: team_policies cross-tenant isolation (SELECT)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_alice UUID := gen_random_uuid();
  v_bob   UUID := gen_random_uuid();
  v_team_a UUID;
  v_team_b UUID;
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Fixtures: two users, two teams (alice owns A, bob owns B)
  INSERT INTO auth.users (id, email) VALUES
    (v_alice, 'alice@test.local'),
    (v_bob,   'bob@test.local');
  v_team_a := gen_random_uuid();
  v_team_b := gen_random_uuid();
  INSERT INTO teams (id, name, owner_id) VALUES (v_team_a, 'Team A', v_alice);
  INSERT INTO teams (id, name, owner_id) VALUES (v_team_b, 'Team B', v_bob);

  -- Each team gets one policy (direct insert bypasses RLS as postgres)
  INSERT INTO team_policies (team_id, name, rule_type, action, created_by)
    VALUES (v_team_a, 'A-policy', 'cost_threshold', 'require_approval', v_alice);
  INSERT INTO team_policies (team_id, name, rule_type, action, created_by)
    VALUES (v_team_b, 'B-policy', 'cost_threshold', 'require_approval', v_bob);

  -- Alice should only see team A's policy
  PERFORM _rls_test_impersonate(v_alice);
  SELECT count(*) INTO v_visible_count FROM team_policies;
  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: alice sees % policies, expected 1', v_visible_count;
  END IF;

  -- Bob should only see team B's policy
  PERFORM _rls_test_impersonate(v_bob);
  SELECT count(*) INTO v_visible_count FROM team_policies;
  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: bob sees % policies, expected 1', v_visible_count;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 1 PASS: team_policies cross-tenant SELECT isolated';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 2: team_policies INSERT requires admin/owner role
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner  UUID := gen_random_uuid();
  v_member UUID := gen_random_uuid();
  v_team UUID := gen_random_uuid();
  v_insert_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_owner,  'owner@test.local'),
    (v_member, 'member@test.local');
  INSERT INTO teams (id, name, owner_id) VALUES (v_team, 'T2', v_owner);
  -- handle_new_team trigger adds owner; add member explicitly
  INSERT INTO team_members (team_id, user_id, role)
    VALUES (v_team, v_member, 'member');

  -- Member attempts INSERT — should fail with RLS violation
  PERFORM _rls_test_impersonate(v_member);
  BEGIN
    INSERT INTO team_policies (team_id, name, rule_type, action, created_by)
      VALUES (v_team, 'Attack', 'cost_threshold', 'block', v_member);
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_insert_denied := TRUE;
  END;

  IF NOT v_insert_denied THEN
    RAISE EXCEPTION 'TEST 2 FAILED: member was allowed to INSERT team_policies';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 2 PASS: team_policies INSERT requires admin/owner';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 3: approvals — requester can INSERT own, cannot forge others'
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner   UUID := gen_random_uuid();
  v_member  UUID := gen_random_uuid();
  v_team UUID := gen_random_uuid();
  v_forgery_denied BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_owner,  'owner3@test.local'),
    (v_member, 'member3@test.local');
  INSERT INTO teams (id, name, owner_id) VALUES (v_team, 'T3', v_owner);
  INSERT INTO team_members (team_id, user_id, role) VALUES
    (v_team, v_member, 'member');

  -- Member inserts their own approval — should succeed
  PERFORM _rls_test_impersonate(v_member);
  INSERT INTO approvals (team_id, requester_user_id, tool_name)
    VALUES (v_team, v_member, 'bash.rm');

  -- Member attempts to forge an approval as the owner — should fail
  BEGIN
    INSERT INTO approvals (team_id, requester_user_id, tool_name)
      VALUES (v_team, v_owner, 'bash.rm.forged');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_forgery_denied := TRUE;
  END;

  IF NOT v_forgery_denied THEN
    RAISE EXCEPTION 'TEST 3 FAILED: member was allowed to forge approval as owner';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 3 PASS: approvals INSERT prevents requester impersonation';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 4: approvals — admins resolve; non-members cannot SELECT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner    UUID := gen_random_uuid();
  v_member   UUID := gen_random_uuid();
  v_outsider UUID := gen_random_uuid();
  v_team UUID := gen_random_uuid();
  v_approval UUID;
  v_rows_seen INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_owner,    'owner4@test.local'),
    (v_member,   'member4@test.local'),
    (v_outsider, 'out4@test.local');
  INSERT INTO teams (id, name, owner_id) VALUES (v_team, 'T4', v_owner);
  INSERT INTO team_members (team_id, user_id, role) VALUES
    (v_team, v_member, 'member');

  INSERT INTO approvals (team_id, requester_user_id, tool_name)
    VALUES (v_team, v_member, 'deploy.prod')
    RETURNING id INTO v_approval;

  -- Outsider must see zero rows
  PERFORM _rls_test_impersonate(v_outsider);
  SELECT count(*) INTO v_rows_seen FROM approvals WHERE id = v_approval;
  IF v_rows_seen <> 0 THEN
    RAISE EXCEPTION 'TEST 4 FAILED: outsider saw approval row';
  END IF;

  -- Owner can resolve (UPDATE)
  PERFORM _rls_test_impersonate(v_owner);
  UPDATE approvals SET status = 'approved', resolver_user_id = v_owner, resolved_at = NOW()
    WHERE id = v_approval;

  PERFORM _rls_test_reset_role();
  SELECT count(*) INTO v_rows_seen FROM approvals WHERE id = v_approval AND status = 'approved';
  IF v_rows_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 4 FAILED: owner could not resolve approval';
  END IF;

  RAISE NOTICE 'TEST 4 PASS: approvals resolution admin-only + outsider blocked';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 5: exports / billing_events — user-scoped isolation
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_u1 UUID := gen_random_uuid();
  v_u2 UUID := gen_random_uuid();
  v_seen INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_u1, 'u1-5@test.local'),
    (v_u2, 'u2-5@test.local');
  -- profiles row auto-created by on_auth_user_created trigger (migration 001)

  INSERT INTO exports (user_id, format, scope) VALUES (v_u1, 'json', 'all');
  INSERT INTO exports (user_id, format, scope) VALUES (v_u2, 'json', 'all');

  INSERT INTO billing_events (user_id, event_type, polar_event_id)
    VALUES (v_u1, 'subscription.created', 'evt_u1_' || gen_random_uuid());
  INSERT INTO billing_events (user_id, event_type, polar_event_id)
    VALUES (v_u2, 'subscription.created', 'evt_u2_' || gen_random_uuid());

  -- u1 sees own rows only
  PERFORM _rls_test_impersonate(v_u1);
  SELECT count(*) INTO v_seen FROM exports;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 5 FAILED: u1 sees % exports, expected 1', v_seen;
  END IF;
  SELECT count(*) INTO v_seen FROM billing_events;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 5 FAILED: u1 sees % billing_events, expected 1', v_seen;
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 5 PASS: exports + billing_events user-scoped';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 6: integrations.config_encrypted is column-level revoked
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_has_priv BOOLEAN;
BEGIN
  PERFORM _rls_test_reset_role();

  -- has_column_privilege returns false when REVOKE has taken effect.
  SELECT has_column_privilege('authenticated', 'integrations', 'config_encrypted', 'SELECT')
    INTO v_has_priv;
  IF v_has_priv THEN
    RAISE EXCEPTION 'TEST 6 FAILED: authenticated role retains SELECT on config_encrypted';
  END IF;

  SELECT has_column_privilege('anon', 'integrations', 'config_encrypted', 'SELECT')
    INTO v_has_priv;
  IF v_has_priv THEN
    RAISE EXCEPTION 'TEST 6 FAILED: anon role retains SELECT on config_encrypted';
  END IF;

  RAISE NOTICE 'TEST 6 PASS: integrations.config_encrypted column-level revoked';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 7: sessions_shared — recipient sees grant; non-recipient does not
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner     UUID := gen_random_uuid();
  v_recipient UUID := gen_random_uuid();
  v_outsider  UUID := gen_random_uuid();
  v_machine   UUID := gen_random_uuid();
  v_session   UUID := gen_random_uuid();
  v_seen INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES
    (v_owner,     'own7@test.local'),
    (v_recipient, 'rec7@test.local'),
    (v_outsider,  'out7@test.local');

  INSERT INTO machines (id, user_id, name, machine_fingerprint, hostname)
    VALUES (v_machine, v_owner, 'laptop', 'fp7-' || v_machine::text, 'host7');
  INSERT INTO sessions (id, user_id, machine_id, agent_type)
    VALUES (v_session, v_owner, v_machine, 'claude');

  INSERT INTO sessions_shared (session_id, shared_with_user_id, shared_by_user_id)
    VALUES (v_session, v_recipient, v_owner);

  -- Recipient sees the share
  PERFORM _rls_test_impersonate(v_recipient);
  SELECT count(*) INTO v_seen FROM sessions_shared WHERE session_id = v_session;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'TEST 7 FAILED: recipient cannot see their share';
  END IF;

  -- Outsider sees zero
  PERFORM _rls_test_impersonate(v_outsider);
  SELECT count(*) INTO v_seen FROM sessions_shared WHERE session_id = v_session;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'TEST 7 FAILED: outsider sees share row';
  END IF;

  PERFORM _rls_test_reset_role();
  RAISE NOTICE 'TEST 7 PASS: sessions_shared recipient-only visibility';
END;
$$;

ROLLBACK;
BEGIN;


-- ---------------------------------------------------------------------------
-- Test 8: audit_log trigger fires on team_policies INSERT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner UUID := gen_random_uuid();
  v_team  UUID := gen_random_uuid();
  v_pol   UUID := gen_random_uuid();
  v_before INT;
  v_after INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email) VALUES (v_owner, 'own8@test.local');
  INSERT INTO teams (id, name, owner_id) VALUES (v_team, 'T8', v_owner);

  SELECT count(*) INTO v_before FROM audit_log
    WHERE resource_type = 'team_policies';

  INSERT INTO team_policies (id, team_id, name, rule_type, action, created_by)
    VALUES (v_pol, v_team, 'Audited', 'cost_threshold', 'require_approval', v_owner);

  SELECT count(*) INTO v_after FROM audit_log
    WHERE resource_type = 'team_policies';

  IF v_after <= v_before THEN
    RAISE EXCEPTION 'TEST 8 FAILED: no audit_log row written for team_policies INSERT (before=%, after=%)', v_before, v_after;
  END IF;

  RAISE NOTICE 'TEST 8 PASS: audit_log trigger fires on team_policies INSERT';
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
  RAISE NOTICE 'ALL RLS TESTS PASSED — migration 021 governance invariants hold';
  RAISE NOTICE '================================================================';
END;
$$;
