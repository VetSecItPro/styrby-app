-- ============================================================================
-- RLS TEST SUITE: Migration 048 (support_access_grants)
-- ============================================================================
--
-- PURPOSE:
--   Validates the security invariants of migration 048_support_access_grants.sql.
--   All five spec-required invariants are covered (T1 success criteria).
--
-- USAGE (local — requires Docker + Supabase CLI):
--   supabase db reset               # applies all migrations 001-048
--   psql "$DB_URL" -f supabase/tests/rls/support_access_grants_rls.sql
--
-- CI GATE:
--   Phase 4.0 GitHub Actions workflow runs supabase db reset + this script.
--   Local Docker unavailable during T1 development; CI is the verification gate.
--
-- EXIT SEMANTICS:
--   - Each test block is wrapped in BEGIN ... ROLLBACK to avoid state pollution.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL SUPPORT_ACCESS_GRANTS RLS TESTS PASSED".
--
-- SECURITY INVARIANTS UNDER TEST:
--   (a) Non-owner non-admin cannot SELECT any grant rows
--   (b) Owner (user_id = auth.uid()) can SELECT only their own rows
--   (c) Site admin can SELECT all rows (cross-user)
--   (d) Direct UPDATE is rejected with SQLSTATE 42501 (REVOKE + no policy)
--   (e) Direct DELETE is rejected with SQLSTATE 42501 (REVOKE + no policy)
--
-- SOC2 CC6.1: Least privilege — app roles cannot SELECT other users' grants;
--   cannot directly UPDATE or DELETE grant rows.
-- SOC2 CC7.2: Mutations only via SECURITY DEFINER wrappers (migration 049).
-- OWASP A01:2021: Broken Access Control mitigated at Postgres RLS + REVOKE layer.
-- GDPR Article 7: Per-session consent; user can only see and act on their own grants.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test harness — mirrors admin_console_rls.sql exactly for consistency.
-- Idempotent CREATE OR REPLACE so running this after admin_console_rls.sql
-- in the same session is safe (they share the same helpers).
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
-- Shared fixture helper: insert a support_access_grant row bypassing RLS.
-- Used by tests (a), (b), (c), (d), (e) to seed data before impersonation.
--
-- WHY a helper function: the INSERT requires superuser context (no INSERT
-- policy exists by design). Centralising it avoids repeating the column list
-- in every test and documents the architectural intent ("this is the only
-- non-wrapper INSERT path — test harness only").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_seed_grant(
  p_ticket_id  uuid,
  p_user_id    uuid,
  p_session_id uuid,
  p_admin_id   uuid,
  p_reason     text DEFAULT 'rls test seed'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant_id bigint;
BEGIN
  -- Direct INSERT as superuser — bypasses RLS. This is the test-only path.
  -- WHY token_hash is a static hex string: tests do not exercise token
  -- lookup or timingSafeEqual here (those are covered by T3 + integration
  -- tests). The hash just needs to be unique per call to avoid UNIQUE constraint
  -- violations. We use lpad(md5(random()::text), 64, '0') — not a real SHA-256
  -- but produces a 64-char hex-like string valid for the text NOT NULL column
  -- and the UNIQUE index (distinct per call due to random()).
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash,
     status, expires_at, reason)
  VALUES
    (p_ticket_id, p_user_id, p_session_id, p_admin_id,
     lpad(md5(random()::text), 64, '0'),
     'approved',
     now() + interval '24 hours',
     p_reason)
  RETURNING id INTO v_grant_id;

  RETURN v_grant_id;
END;
$$;

/*
 * _rls_seed_session: inserts a minimal sessions row bypassing RLS.
 *
 * WHY a separate helper: the sessions table has several NOT NULL columns
 * (machine_id, agent_type, status) and user_id references profiles(id)
 * rather than auth.users(id) directly. This helper encapsulates the fixture
 * complexity so each test block stays readable.
 *
 * It seeds the minimum required chain:
 *   auth.users → profiles (via handle_new_user trigger, or direct INSERT if trigger absent)
 *   → machines → sessions
 *
 * NOTE: Supabase local runs handle_new_user trigger automatically on
 * auth.users INSERT, creating the profiles row. If the trigger is disabled
 * or not present (e.g., partial test DB), the profiles INSERT below acts
 * as a safe fallback.
 */
CREATE OR REPLACE FUNCTION _rls_seed_session(
  p_session_id uuid,
  p_user_id    uuid  -- auth.users.id (profiles row must already exist)
)
RETURNS uuid  -- returns p_session_id for chaining
LANGUAGE plpgsql
AS $$
DECLARE
  v_machine_id uuid := gen_random_uuid();
BEGIN
  -- Ensure profiles row exists (handle_new_user trigger may have already created it)
  INSERT INTO public.profiles (id)
    VALUES (p_user_id)
    ON CONFLICT (id) DO NOTHING;

  -- Seed a minimal machine row (required FK on sessions).
  -- WHY name included: machines.name is TEXT NOT NULL (migration 001).
  INSERT INTO public.machines
    (id, user_id, name, machine_fingerprint, hostname, cli_version, is_online)
  VALUES
    (v_machine_id, p_user_id,
     'rls-test-machine',
     'test-fp-' || left(p_session_id::text, 8),  -- unique fingerprint per session
     'rls-test-host', '0.0.1-test', false)
  ON CONFLICT DO NOTHING;

  -- Seed a minimal session row
  INSERT INTO public.sessions
    (id, user_id, machine_id, agent_type, status, title)
  VALUES
    (p_session_id, p_user_id, v_machine_id, 'claude_code', 'completed', 'RLS test session')
  ON CONFLICT (id) DO NOTHING;

  RETURN p_session_id;
END;
$$;


-- ===========================================================================
-- Test (a): Non-owner non-admin cannot SELECT any grant rows
-- ===========================================================================
-- WHY: An authenticated user who is neither the resource owner (user_id) nor a
-- site admin must receive zero rows from support_access_grants. This is the
-- core access-control invariant: a third party cannot enumerate another user's
-- support access history.
--
-- SOC2 CC6.1: Least privilege — only the resource owner and site admins may
--   observe grant rows. Third-party authenticated users are fully denied.
-- OWASP A01:2021: Horizontal privilege escalation prevented at RLS layer.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_owner     UUID := gen_random_uuid();
  v_bystander UUID := gen_random_uuid();
  v_admin     UUID := gen_random_uuid();
  v_ticket_id UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_grant_id  bigint;
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Seed auth users
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner,     'owner_a@rls.test',     'x', now(), now()),
      (v_bystander, 'bystander_a@rls.test', 'x', now(), now()),
      (v_admin,     'admin_a@rls.test',     'x', now(), now());

  -- Seed site_admin for v_admin only
  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed a');

  -- Seed a support ticket owned by v_owner
  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'RLS test ticket', 'RLS test description for test a');

  -- Seed a session owned by v_owner (via helper: seeds profiles + machine + session)
  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Seed one grant row for v_owner as the resource owner
  v_grant_id := _rls_seed_grant(v_ticket_id, v_owner, v_session_id, v_admin, 'test (a) seed');

  -- Impersonate the bystander (not owner, not admin) — must see 0 rows
  PERFORM _rls_test_impersonate(v_bystander);
  SELECT count(*) INTO v_visible_count FROM public.support_access_grants;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'TEST (a) FAILED: bystander sees % grant rows, expected 0', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (a) PASS: non-owner non-admin cannot SELECT any support_access_grants rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ===========================================================================
-- Test (b): Owner can SELECT only their own rows (not other users' rows)
-- ===========================================================================
-- WHY: The resource owner must be able to see their own pending/approved grants
-- so they can make an informed consent decision on the approval page. They must
-- NOT be able to see grants belonging to a different user (horizontal isolation).
--
-- SOC2 CC6.3: Per-session, per-user scoping. Owner sees only their grants.
-- GDPR Article 7: User exercises rights over their own consent records only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner_a    UUID := gen_random_uuid();
  v_owner_b    UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_a   UUID := gen_random_uuid();
  v_ticket_b   UUID := gen_random_uuid();
  v_session_a  UUID := gen_random_uuid();
  v_session_b  UUID := gen_random_uuid();
  v_grant_a    bigint;
  v_grant_b    bigint;
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Seed auth users
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner_a, 'owner_ba@rls.test', 'x', now(), now()),
      (v_owner_b, 'owner_bb@rls.test', 'x', now(), now()),
      (v_admin,   'admin_b@rls.test',  'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed b');

  -- Seed two tickets and two sessions (one per owner)
  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES
      (v_ticket_a, v_owner_a, 'bug', 'RLS test ticket A', 'Test description A'),
      (v_ticket_b, v_owner_b, 'bug', 'RLS test ticket B', 'Test description B');

  PERFORM _rls_seed_session(v_session_a, v_owner_a);
  PERFORM _rls_seed_session(v_session_b, v_owner_b);

  -- Seed one grant per owner
  v_grant_a := _rls_seed_grant(v_ticket_a, v_owner_a, v_session_a, v_admin, 'test (b) grant for owner_a');
  v_grant_b := _rls_seed_grant(v_ticket_b, v_owner_b, v_session_b, v_admin, 'test (b) grant for owner_b');

  -- As owner_a: must see exactly 1 row (their own grant, not owner_b's)
  PERFORM _rls_test_impersonate(v_owner_a);
  SELECT count(*) INTO v_visible_count FROM public.support_access_grants;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: owner_a sees % rows, expected 1 (their own only)', v_visible_count;
  END IF;

  -- Verify the row owner_a sees is specifically their grant (not owner_b's)
  PERFORM _rls_test_impersonate(v_owner_a);
  SELECT count(*) INTO v_visible_count
    FROM public.support_access_grants
    WHERE id = v_grant_a;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: owner_a cannot see their own grant id=%', v_grant_a;
  END IF;

  -- Verify owner_a cannot see owner_b's grant
  PERFORM _rls_test_impersonate(v_owner_a);
  SELECT count(*) INTO v_visible_count
    FROM public.support_access_grants
    WHERE id = v_grant_b;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: owner_a can see owner_b grant id=% (horizontal isolation broken)', v_grant_b;
  END IF;

  RAISE NOTICE 'TEST (b) PASS: owner can SELECT only their own rows; cannot see other users grants';
END;
$$;

ROLLBACK;
BEGIN;

-- ===========================================================================
-- Test (c): Site admin can SELECT all rows (cross-user)
-- ===========================================================================
-- WHY: The admin support console must display all pending/approved/revoked
-- grants across all users to manage support workflows. An admin who created
-- a grant must also be able to see its current status to know whether to
-- attempt a consume.
--
-- SOC2 CC6.1: Admin access is bounded to site admins; not granted to all
--   authenticated users. is_site_admin() is the gate.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner_1    UUID := gen_random_uuid();
  v_owner_2    UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_1   UUID := gen_random_uuid();
  v_ticket_2   UUID := gen_random_uuid();
  v_session_1  UUID := gen_random_uuid();
  v_session_2  UUID := gen_random_uuid();
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Seed three users: two owners, one admin
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner_1, 'owner1_c@rls.test', 'x', now(), now()),
      (v_owner_2, 'owner2_c@rls.test', 'x', now(), now()),
      (v_admin,   'admin_c@rls.test',  'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed c');

  -- Seed tickets and sessions
  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES
      (v_ticket_1, v_owner_1, 'bug', 'RLS ticket 1', 'Test description 1'),
      (v_ticket_2, v_owner_2, 'bug', 'RLS ticket 2', 'Test description 2');

  PERFORM _rls_seed_session(v_session_1, v_owner_1);
  PERFORM _rls_seed_session(v_session_2, v_owner_2);

  -- Seed two grants (one per owner)
  PERFORM _rls_seed_grant(v_ticket_1, v_owner_1, v_session_1, v_admin, 'test (c) grant 1');
  PERFORM _rls_seed_grant(v_ticket_2, v_owner_2, v_session_2, v_admin, 'test (c) grant 2');

  -- As site admin: must see both grants (cross-user SELECT)
  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_visible_count FROM public.support_access_grants;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 2 THEN
    RAISE EXCEPTION 'TEST (c) FAILED: site admin sees % grant rows, expected 2', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (c) PASS: site admin can SELECT all support_access_grants rows across users';
END;
$$;

ROLLBACK;
BEGIN;

-- ===========================================================================
-- Test (d): Direct UPDATE is rejected with SQLSTATE 42501
-- ===========================================================================
-- WHY: UPDATE is explicitly REVOKEd from authenticated/anon/PUBLIC and there is
-- no UPDATE policy. Both layers must cooperate to deny direct mutations. We test
-- both a non-admin and a site admin (the REVOKE is unconditional — even admins
-- cannot bypass it). All mutations must flow through the SECURITY DEFINER
-- wrappers in migration 049 (T2).
--
-- WHY assert SQLSTATE 42501 specifically: a trigger failure or FK violation
-- would also raise WHEN OTHERS but with a different code. 42501 confirms the
-- denial is a privilege rejection, not an incidental error causing a false pass.
--
-- SOC2 CC7.2: Tamper resistance — grant rows cannot be directly mutated
--   by any app role (including admins). Wrappers enforce authorization +
--   audit atomically.
-- OWASP A01:2021: Defense-in-depth; privilege layer denies before any
--   policy-layer check.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner     UUID := gen_random_uuid();
  v_admin     UUID := gen_random_uuid();
  v_ticket_id UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_grant_id  bigint;
  v_caught    BOOLEAN := FALSE;
  v_exc_code  text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner, 'owner_d@rls.test', 'x', now(), now()),
      (v_admin, 'admin_d@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed d');

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'RLS test ticket D', 'Test description D');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  v_grant_id := _rls_seed_grant(v_ticket_id, v_owner, v_session_id, v_admin, 'test (d) seed');

  -- ---- d.1: owner attempting UPDATE → must get 42501 ----
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_owner);
  BEGIN
    UPDATE public.support_access_grants
      SET status = 'consumed'
      WHERE id = v_grant_id;
    -- If we reach here, the UPDATE was not denied — test fails
  EXCEPTION WHEN OTHERS THEN
    v_caught  := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (d.1) FAILED: owner UPDATE on support_access_grants was NOT rejected';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (d.1) FAILED: owner UPDATE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  -- ---- d.2: site admin attempting UPDATE → must also get 42501 (REVOKE is unconditional) ----
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    UPDATE public.support_access_grants
      SET status = 'consumed'
      WHERE id = v_grant_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught  := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (d.2) FAILED: site admin UPDATE on support_access_grants was NOT rejected';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (d.2) FAILED: site admin UPDATE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (d) PASS: direct UPDATE on support_access_grants raises 42501 for both owner and site admin';
END;
$$;

ROLLBACK;
BEGIN;

-- ===========================================================================
-- Test (e): Direct DELETE is rejected with SQLSTATE 42501
-- ===========================================================================
-- WHY: DELETE is also explicitly REVOKEd. Grant rows must persist for audit
-- continuity even after they expire or are consumed. The only legitimate
-- deletion path is ON DELETE CASCADE from the parent ticket or session row
-- (which runs as superuser in Postgres, bypassing app-role restrictions).
-- Direct DELETE by any app role must be denied.
--
-- SOC2 CC7.2: Audit trail — grant history must not be erasable by app roles.
--   The cascade from ticket/session deletion is a legitimate cleanup path
--   (controlled by data lifecycle policy, not individual app callers).
-- SOC2 CC6.1: Least privilege — app roles cannot delete grant rows directly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner     UUID := gen_random_uuid();
  v_admin     UUID := gen_random_uuid();
  v_ticket_id UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_grant_id  bigint;
  v_caught    BOOLEAN := FALSE;
  v_exc_code  text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner, 'owner_e@rls.test', 'x', now(), now()),
      (v_admin, 'admin_e@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed e');

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'RLS test ticket E', 'Test description E');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  v_grant_id := _rls_seed_grant(v_ticket_id, v_owner, v_session_id, v_admin, 'test (e) seed');

  -- ---- e.1: owner attempting DELETE → must get 42501 ----
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_owner);
  BEGIN
    DELETE FROM public.support_access_grants WHERE id = v_grant_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught  := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (e.1) FAILED: owner DELETE on support_access_grants was NOT rejected';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (e.1) FAILED: owner DELETE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  -- ---- e.2: site admin attempting DELETE → must also get 42501 ----
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    DELETE FROM public.support_access_grants WHERE id = v_grant_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught  := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (e.2) FAILED: site admin DELETE on support_access_grants was NOT rejected';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (e.2) FAILED: site admin DELETE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (e) PASS: direct DELETE on support_access_grants raises 42501 for both owner and site admin';
END;
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- All tests passed
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE '=== ALL SUPPORT_ACCESS_GRANTS RLS TESTS PASSED ===';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test harness cleanup — drop helper functions so they do not pollute schema.
--
-- WHY: _rls_test_impersonate, _rls_test_reset_role, and _rls_seed_grant are
-- test-only helpers. Leaving them in the DB creates an unnecessary attack
-- surface (a caller could invoke _rls_test_impersonate to elevate apparent
-- role context). Dropping here ensures a clean schema after the test suite.
-- The first two are shared with admin_console_rls.sql; DROP IF EXISTS is
-- idempotent whether or not they were defined by this file or the other.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
DROP FUNCTION IF EXISTS _rls_test_reset_role();
DROP FUNCTION IF EXISTS _rls_seed_grant(uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS _rls_seed_session(uuid, uuid);
