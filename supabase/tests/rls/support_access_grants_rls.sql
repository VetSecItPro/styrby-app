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

-- ===========================================================================
-- T2 WRAPPER TESTS: Migration 049 (SECURITY DEFINER functions)
-- ===========================================================================
--
-- Test blocks (f)–(k) exercise the four SECURITY DEFINER wrapper functions
-- created in migration 049. They verify:
--   (f) admin_request_support_access happy path — grant + audit rows created
--   (g) admin_request_support_access rejects non-admin (42501)
--   (h) admin_request_support_access rejects session not owned by p_user_id
--   (i) user_approve_support_access happy path + rejects non-owner + rejects non-pending
--   (j) user_revoke_support_access happy path + idempotent on terminal state
--   (k) admin_consume_support_access happy path + access_count increments +
--       auto-consumed at cap + rejects expired + rejects pending status
--
-- HARNESS NOTE:
--   These tests call the SECURITY DEFINER wrappers directly via the postgres
--   superuser role. The wrappers check auth.uid() via is_site_admin(); for admin
--   wrapper tests we use _rls_test_impersonate to set the JWT claim, then call
--   the function. For user wrapper tests we impersonate the resource owner.
--   "service_role" GRANT restriction is enforced at the Postgres privilege layer
--   and cannot be easily tested in a pgTAP-style script without switching roles.
--   These tests validate the SECURITY DEFINER logic (authorization, state machine,
--   audit rows) — the GRANT restriction is validated by CI integration tests.
--
-- SOC2 CC7.2: Every mutation path audited; wrapper tests validate this invariant.
-- OWASP A01:2021: Authorization checks inside every function tested for both
--   happy path and rejection cases.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Test (f): admin_request_support_access happy path
--   - Creates a pending grant row
--   - Writes an audit row with action='support_access_requested'
-- ---------------------------------------------------------------------------
-- WHY: Validates the primary create path — the most exercised code path in
-- normal support workflows. Confirms grant row is properly seeded and audit
-- trail is written atomically.
--
-- SOC2 CC7.2: Grant creation and audit write are atomic.
-- GDPR Article 7: Pending status confirms user has not yet been asked to consent.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_id  UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_token_hash text := lpad(md5(random()::text), 64, '0');
  v_grant_id   bigint;
  v_grant_row  public.support_access_grants%ROWTYPE;
  v_audit_count int;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Seed auth users
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner, 'owner_f@rls.test', 'x', now(), now()),
      (v_admin, 'admin_f@rls.test', 'x', now(), now());

  -- Make v_admin a site admin
  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed f');

  -- Seed support ticket owned by v_owner
  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'Test ticket F', 'Test description for test f');

  -- Seed session owned by v_owner
  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Impersonate admin to call the wrapper (auth.uid() = v_admin → is_site_admin = true)
  PERFORM _rls_test_impersonate(v_admin);

  v_grant_id := public.admin_request_support_access(
    v_ticket_id, v_owner, v_session_id,
    'Investigating crash in session',
    24,
    v_token_hash
  );

  PERFORM _rls_test_reset_role();

  -- Verify grant row created with correct initial state
  SELECT * INTO v_grant_row
    FROM public.support_access_grants
    WHERE id = v_grant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST (f) FAILED: grant row not found after admin_request_support_access';
  END IF;

  IF v_grant_row.status <> 'pending' THEN
    RAISE EXCEPTION 'TEST (f) FAILED: expected status=pending, got %', v_grant_row.status;
  END IF;

  IF v_grant_row.user_id <> v_owner THEN
    RAISE EXCEPTION 'TEST (f) FAILED: grant.user_id mismatch';
  END IF;

  IF v_grant_row.session_id <> v_session_id THEN
    RAISE EXCEPTION 'TEST (f) FAILED: grant.session_id mismatch';
  END IF;

  IF v_grant_row.token_hash <> v_token_hash THEN
    RAISE EXCEPTION 'TEST (f) FAILED: token_hash not stored correctly';
  END IF;

  IF v_grant_row.granted_by <> v_admin THEN
    RAISE EXCEPTION 'TEST (f) FAILED: granted_by should be admin UUID';
  END IF;

  -- Verify audit row was written in the same transaction
  SELECT count(*) INTO v_audit_count
    FROM public.admin_audit_log
    WHERE action = 'support_access_requested'
      AND target_user_id = v_owner
      AND actor_id = v_admin
      AND after_json->>'grant_id' = v_grant_id::text;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (f) FAILED: expected 1 audit row for support_access_requested, got %', v_audit_count;
  END IF;

  RAISE NOTICE 'TEST (f) PASS: admin_request_support_access creates grant + audit row atomically';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (g): admin_request_support_access rejects non-admin (42501)
-- ---------------------------------------------------------------------------
-- WHY: Confirms that a regular authenticated user who is NOT in site_admins
-- cannot create support access grants. is_site_admin(auth.uid()) must return
-- false and the function must raise 42501.
--
-- SOC2 CC6.1: Least privilege — only site admins may request support access.
-- OWASP A01:2021: Broken access control mitigated at function body level
--   (defense-in-depth over the service_role GRANT restriction).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_non_admin  UUID := gen_random_uuid();
  v_ticket_id  UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_token_hash text := lpad(md5(random()::text), 64, '0');
  v_caught     BOOLEAN := FALSE;
  v_exc_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner,     'owner_g@rls.test',     'x', now(), now()),
      (v_non_admin, 'non_admin_g@rls.test', 'x', now(), now());

  -- Deliberately do NOT add v_non_admin to site_admins

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'Test ticket G', 'Test description for test g');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Impersonate non-admin
  PERFORM _rls_test_impersonate(v_non_admin);

  BEGIN
    PERFORM public.admin_request_support_access(
      v_ticket_id, v_owner, v_session_id,
      'Attempting unauthorized access',
      24,
      v_token_hash
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (g) FAILED: non-admin call was NOT rejected';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (g) FAILED: expected SQLSTATE 42501, got %', v_exc_code;
  END IF;

  -- Verify no grant row was created (transaction is clean)
  PERFORM 1 FROM public.support_access_grants WHERE token_hash = v_token_hash;
  IF FOUND THEN
    RAISE EXCEPTION 'TEST (g) FAILED: grant row was created despite non-admin rejection';
  END IF;

  RAISE NOTICE 'TEST (g) PASS: admin_request_support_access rejects non-admin with 42501';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (h): admin_request_support_access rejects session not owned by p_user_id
-- ---------------------------------------------------------------------------
-- WHY: Validates the session ownership check. An admin passing a session that
-- belongs to user A but claiming it belongs to user B must be rejected (22023).
-- This prevents admins from gaining access to sessions by misattributing ownership.
--
-- SOC2 CC6.3: Per-session scoping — the session must belong to the declared user.
-- GDPR Article 25: Data minimisation — access scoped to a specific user's session.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner_real UUID := gen_random_uuid();
  v_owner_wrong UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_id  UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_token_hash text := lpad(md5(random()::text), 64, '0');
  v_caught     BOOLEAN := FALSE;
  v_exc_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner_real,  'owner_real_h@rls.test',  'x', now(), now()),
      (v_owner_wrong, 'owner_wrong_h@rls.test', 'x', now(), now()),
      (v_admin,       'admin_h@rls.test',        'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed h');

  -- Ticket belongs to v_owner_wrong
  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner_wrong, 'bug', 'Test ticket H', 'Test description for test h');

  -- Session belongs to v_owner_real (not v_owner_wrong)
  PERFORM _rls_seed_session(v_session_id, v_owner_real);

  -- Admin tries to create grant claiming session belongs to v_owner_wrong (lie)
  PERFORM _rls_test_impersonate(v_admin);

  BEGIN
    PERFORM public.admin_request_support_access(
      v_ticket_id, v_owner_wrong, v_session_id,
      'Testing session ownership mismatch',
      24,
      v_token_hash
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (h) FAILED: mismatched session ownership was NOT rejected';
  END IF;
  IF v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (h) FAILED: expected SQLSTATE 22023, got %', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (h) PASS: admin_request_support_access rejects session not owned by p_user_id';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (i): user_approve_support_access — happy path + non-owner rejection +
--           rejection of already-consumed grant (state machine enforcement)
-- ---------------------------------------------------------------------------
-- WHY: Three sub-tests in one block share setup to keep the test suite efficient.
--   i.1: owner approves own pending grant → status='approved', audit written
--   i.2: non-owner trying to approve → 42501
--   i.3: approving an already-consumed grant → 22023 (state machine forward-only)
--
-- SOC2 CC9.2: User approval flow verified end-to-end.
-- GDPR Article 7: Affirmative consent via approval; audit trail created.
-- SOC2 CC7.2: State machine prevents back-edges (consumed → pending bypass).
-- OWASP A01:2021: Non-owner cannot approve another user's grant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_bystander  UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_id  UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_grant_id   bigint;
  v_consumed_grant_id bigint;
  v_audit_id   bigint;
  v_grant_row  public.support_access_grants%ROWTYPE;
  v_caught     BOOLEAN;
  v_exc_code   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner,     'owner_i@rls.test',     'x', now(), now()),
      (v_bystander, 'bystander_i@rls.test', 'x', now(), now()),
      (v_admin,     'admin_i@rls.test',     'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed i');

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'Test ticket I', 'Test description for test i');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Seed a pending grant via admin wrapper
  PERFORM _rls_test_impersonate(v_admin);
  v_grant_id := public.admin_request_support_access(
    v_ticket_id, v_owner, v_session_id,
    'Testing approve happy path',
    24,
    lpad(md5(random()::text), 64, '0')
  );

  -- Seed a consumed grant directly (test harness — bypasses RLS) for sub-test i.3
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash, status, expires_at, reason)
  VALUES
    (v_ticket_id, v_owner, v_session_id, v_admin,
     lpad(md5(random()::text), 64, '0'),
     'consumed',
     now() + interval '24 hours',
     'test i.3 consumed grant')
  RETURNING id INTO v_consumed_grant_id;

  PERFORM _rls_test_reset_role();

  -- ── i.1: Owner approves own pending grant ──────────────────────────────────
  PERFORM _rls_test_impersonate(v_owner);
  v_audit_id := public.user_approve_support_access(v_grant_id);
  PERFORM _rls_test_reset_role();

  -- Verify status transition
  SELECT * INTO v_grant_row
    FROM public.support_access_grants WHERE id = v_grant_id;

  IF v_grant_row.status <> 'approved' THEN
    RAISE EXCEPTION 'TEST (i.1) FAILED: expected status=approved, got %', v_grant_row.status;
  END IF;

  IF v_grant_row.approved_at IS NULL THEN
    RAISE EXCEPTION 'TEST (i.1) FAILED: approved_at not set after approval';
  END IF;

  IF v_audit_id IS NULL OR v_audit_id = 0 THEN
    RAISE EXCEPTION 'TEST (i.1) FAILED: audit_id not returned from user_approve_support_access';
  END IF;

  RAISE NOTICE 'TEST (i.1) PASS: owner can approve own pending grant';

  -- ── i.2: Bystander (non-owner) cannot approve owner's grant ──────────────
  -- Seed another pending grant for this sub-test
  PERFORM _rls_test_impersonate(v_admin);
  DECLARE
    v_grant_id_2 bigint;
  BEGIN
    v_grant_id_2 := public.admin_request_support_access(
      v_ticket_id, v_owner, v_session_id,
      'Testing non-owner approval rejection',
      24,
      lpad(md5(random()::text), 64, '0')
    );
    PERFORM _rls_test_reset_role();

    v_caught := FALSE;
    v_exc_code := NULL;
    PERFORM _rls_test_impersonate(v_bystander);
    BEGIN
      PERFORM public.user_approve_support_access(v_grant_id_2);
    EXCEPTION WHEN OTHERS THEN
      v_caught := TRUE;
      GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
    END;
    PERFORM _rls_test_reset_role();

    IF NOT v_caught THEN
      RAISE EXCEPTION 'TEST (i.2) FAILED: non-owner approval was NOT rejected';
    END IF;
    IF v_exc_code NOT IN ('42501', '22023') THEN
      RAISE EXCEPTION 'TEST (i.2) FAILED: expected 42501 or 22023, got %', v_exc_code;
    END IF;
  END;

  RAISE NOTICE 'TEST (i.2) PASS: non-owner cannot approve another user''s grant';

  -- ── i.3: Cannot approve an already-consumed grant (state machine) ─────────
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_owner);
  BEGIN
    PERFORM public.user_approve_support_access(v_consumed_grant_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (i.3) FAILED: approving consumed grant was NOT rejected';
  END IF;
  IF v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (i.3) FAILED: expected SQLSTATE 22023, got %', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (i.3) PASS: user_approve_support_access rejects consumed grant (forward-only state machine)';
  RAISE NOTICE 'TEST (i) PASS: all user_approve_support_access sub-tests passed';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (j): user_revoke_support_access — happy path + idempotent on terminal state
-- ---------------------------------------------------------------------------
-- WHY: Two sub-tests:
--   j.1: Owner revokes an approved grant → status='revoked', audit written,
--        revoked_at set
--   j.2: Revoking an already-revoked grant → returns 0 (idempotent no-op),
--        no new audit row written (prevents audit log inflation from retries)
--
-- SOC2 CC9.2: Revocation takes effect immediately at DB layer.
-- GDPR Article 7: Consent revocable at any time; no restriction on timing.
-- SOC2 CC7.2: Revocation audited; idempotent path writes no duplicate audit row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_ticket_id  UUID := gen_random_uuid();
  v_session_id UUID := gen_random_uuid();
  v_grant_id   bigint;
  v_grant_id_2 bigint;
  v_result     bigint;
  v_grant_row  public.support_access_grants%ROWTYPE;
  v_audit_count_before int;
  v_audit_count_after  int;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner, 'owner_j@rls.test', 'x', now(), now()),
      (v_admin, 'admin_j@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed j');

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'Test ticket J', 'Test description for test j');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Seed an approved grant for j.1
  PERFORM _rls_test_impersonate(v_admin);
  v_grant_id := public.admin_request_support_access(
    v_ticket_id, v_owner, v_session_id,
    'Testing revoke happy path',
    24,
    lpad(md5(random()::text), 64, '0')
  );
  PERFORM _rls_test_reset_role();

  -- Approve it first so it's in 'approved' state
  PERFORM _rls_test_impersonate(v_owner);
  PERFORM public.user_approve_support_access(v_grant_id);
  PERFORM _rls_test_reset_role();

  -- ── j.1: Owner revokes an approved grant ──────────────────────────────────
  PERFORM _rls_test_impersonate(v_owner);
  v_result := public.user_revoke_support_access(v_grant_id);
  PERFORM _rls_test_reset_role();

  SELECT * INTO v_grant_row FROM public.support_access_grants WHERE id = v_grant_id;

  IF v_grant_row.status <> 'revoked' THEN
    RAISE EXCEPTION 'TEST (j.1) FAILED: expected status=revoked, got %', v_grant_row.status;
  END IF;

  IF v_grant_row.revoked_at IS NULL THEN
    RAISE EXCEPTION 'TEST (j.1) FAILED: revoked_at not set after revocation';
  END IF;

  IF v_result = 0 THEN
    RAISE EXCEPTION 'TEST (j.1) FAILED: expected non-zero audit_id, got 0 (idempotent path taken on non-terminal grant)';
  END IF;

  RAISE NOTICE 'TEST (j.1) PASS: owner can revoke approved grant; status=revoked, revoked_at set';

  -- ── j.2: Revoking already-revoked grant is idempotent (returns 0) ─────────
  -- Count audit rows before idempotent call
  SELECT count(*) INTO v_audit_count_before
    FROM public.admin_audit_log
    WHERE action = 'support_access_revoked'
      AND after_json->>'grant_id' = v_grant_id::text;

  PERFORM _rls_test_impersonate(v_owner);
  v_result := public.user_revoke_support_access(v_grant_id);
  PERFORM _rls_test_reset_role();

  IF v_result <> 0 THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: expected return 0 for idempotent revoke, got %', v_result;
  END IF;

  -- Verify no new audit row was written
  SELECT count(*) INTO v_audit_count_after
    FROM public.admin_audit_log
    WHERE action = 'support_access_revoked'
      AND after_json->>'grant_id' = v_grant_id::text;

  IF v_audit_count_after <> v_audit_count_before THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: idempotent revoke wrote % new audit row(s), expected 0',
      v_audit_count_after - v_audit_count_before;
  END IF;

  RAISE NOTICE 'TEST (j.2) PASS: revoking already-revoked grant is idempotent (returns 0, no new audit row)';
  RAISE NOTICE 'TEST (j) PASS: all user_revoke_support_access sub-tests passed';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (k): admin_consume_support_access — happy path + access_count increment +
--           auto-consumed at max_access_count cap + rejects expired + rejects pending
-- ---------------------------------------------------------------------------
-- WHY: Five sub-tests:
--   k.1: Admin consumes approved grant → returns (grant_id, session_id, scope),
--        access_count increments by 1, audit row written
--   k.2: At max_access_count cap → status transitions to 'consumed', access_count
--        equals max_access_count (atomic CAS verified)
--   k.3: Attempting consume after status='consumed' → 22023 (access denied)
--   k.4: Attempting consume on expired grant → 22023 (access denied)
--   k.5: Attempting consume on pending grant → 22023 (must be approved first)
--
-- SOC2 A1.1: Blast-radius cap (max_access_count) enforced atomically.
-- SOC2 CC7.2: Every consume audited; access_count CAS verified.
-- OWASP A04:2021: TOCTOU on view count prevented by FOR UPDATE CAS.
-- OWASP A02:2021: Same error (22023) for all rejection modes — oracle attack mitigation.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_admin        UUID := gen_random_uuid();
  v_ticket_id    UUID := gen_random_uuid();
  v_session_id   UUID := gen_random_uuid();
  v_token_hash_1 text := lpad(md5(random()::text), 64, '0');
  v_token_hash_2 text := lpad(md5(random()::text), 64, '0');
  v_token_hash_3 text := lpad(md5(random()::text), 64, '0');
  v_token_hash_4 text := lpad(md5(random()::text), 64, '0');
  v_grant_id_1   bigint;
  v_grant_id_cap bigint;
  v_grant_row    public.support_access_grants%ROWTYPE;
  v_ret_grant_id bigint;
  v_ret_session  uuid;
  v_ret_scope    jsonb;
  v_audit_count  int;
  v_caught       BOOLEAN;
  v_exc_code     text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_owner, 'owner_k@rls.test', 'x', now(), now()),
      (v_admin, 'admin_k@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed k');

  INSERT INTO public.support_tickets (id, user_id, type, subject, description)
    VALUES (v_ticket_id, v_owner, 'bug', 'Test ticket K', 'Test description for test k');

  PERFORM _rls_seed_session(v_session_id, v_owner);

  -- Seed grant #1 (for k.1: normal happy path consume)
  PERFORM _rls_test_impersonate(v_admin);
  v_grant_id_1 := public.admin_request_support_access(
    v_ticket_id, v_owner, v_session_id,
    'Testing consume happy path',
    24,
    v_token_hash_1
  );
  PERFORM _rls_test_reset_role();

  -- Approve grant #1
  PERFORM _rls_test_impersonate(v_owner);
  PERFORM public.user_approve_support_access(v_grant_id_1);
  PERFORM _rls_test_reset_role();

  -- ── k.1: Happy path consume — access_count increments, returns session data ─
  PERFORM _rls_test_impersonate(v_admin);
  SELECT r.grant_id, r.session_id, r.scope
    INTO v_ret_grant_id, v_ret_session, v_ret_scope
    FROM public.admin_consume_support_access(v_token_hash_1) r;
  PERFORM _rls_test_reset_role();

  IF v_ret_grant_id <> v_grant_id_1 THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: returned grant_id % does not match expected %', v_ret_grant_id, v_grant_id_1;
  END IF;

  IF v_ret_session <> v_session_id THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: returned session_id does not match expected session_id';
  END IF;

  IF v_ret_scope IS NULL THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: returned scope is NULL';
  END IF;

  -- Verify access_count incremented
  SELECT * INTO v_grant_row FROM public.support_access_grants WHERE id = v_grant_id_1;
  IF v_grant_row.access_count <> 1 THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: expected access_count=1, got %', v_grant_row.access_count;
  END IF;

  -- Verify audit row written
  SELECT count(*) INTO v_audit_count
    FROM public.admin_audit_log
    WHERE action = 'support_access_used'
      AND after_json->>'grant_id' = v_grant_id_1::text;
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: expected 1 audit row for support_access_used, got %', v_audit_count;
  END IF;

  RAISE NOTICE 'TEST (k.1) PASS: admin_consume_support_access returns correct data and increments access_count';

  -- ── k.2: At cap → status transitions to consumed ──────────────────────────
  -- Seed a grant with max_access_count=1 directly (test harness) so one consume
  -- exhausts it immediately.
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash, status, expires_at,
     max_access_count, access_count, reason)
  VALUES
    (v_ticket_id, v_owner, v_session_id, v_admin,
     v_token_hash_2,
     'approved',
     now() + interval '24 hours',
     1, 0,  -- max_access_count=1 so first consume exhausts it
     'test k.2 cap grant')
  RETURNING id INTO v_grant_id_cap;

  PERFORM _rls_test_impersonate(v_admin);
  PERFORM public.admin_consume_support_access(v_token_hash_2);
  PERFORM _rls_test_reset_role();

  SELECT * INTO v_grant_row FROM public.support_access_grants WHERE id = v_grant_id_cap;
  IF v_grant_row.status <> 'consumed' THEN
    RAISE EXCEPTION 'TEST (k.2) FAILED: expected status=consumed after hitting cap, got %', v_grant_row.status;
  END IF;
  IF v_grant_row.access_count <> 1 THEN
    RAISE EXCEPTION 'TEST (k.2) FAILED: expected access_count=1 after hitting cap, got %', v_grant_row.access_count;
  END IF;

  RAISE NOTICE 'TEST (k.2) PASS: grant auto-transitions to consumed when access_count reaches max_access_count';

  -- ── k.3: Consuming a consumed grant → 22023 ───────────────────────────────
  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    PERFORM public.admin_consume_support_access(v_token_hash_2);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (k.3) FAILED: consuming consumed grant was NOT rejected';
  END IF;
  IF v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (k.3) FAILED: expected SQLSTATE 22023, got %', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (k.3) PASS: consuming consumed grant raises 22023';

  -- ── k.4: Consuming an expired grant → 22023 ───────────────────────────────
  -- Seed a grant with expires_at in the past
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash, status, expires_at, reason)
  VALUES
    (v_ticket_id, v_owner, v_session_id, v_admin,
     v_token_hash_3,
     'approved',
     now() - interval '1 hour',  -- already expired
     'test k.4 expired grant');

  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    PERFORM public.admin_consume_support_access(v_token_hash_3);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (k.4) FAILED: consuming expired grant was NOT rejected';
  END IF;
  IF v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (k.4) FAILED: expected SQLSTATE 22023, got %', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (k.4) PASS: consuming expired grant raises 22023';

  -- ── k.5: Consuming a pending grant (not yet approved) → 22023 ─────────────
  -- Seed a pending grant (not approved)
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash, status, expires_at, reason)
  VALUES
    (v_ticket_id, v_owner, v_session_id, v_admin,
     v_token_hash_4,
     'pending',
     now() + interval '24 hours',
     'test k.5 pending grant');

  v_caught := FALSE;
  v_exc_code := NULL;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    PERFORM public.admin_consume_support_access(v_token_hash_4);
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (k.5) FAILED: consuming pending grant was NOT rejected';
  END IF;
  IF v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (k.5) FAILED: expected SQLSTATE 22023, got %', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (k.5) PASS: consuming pending grant raises 22023 (must be approved first)';
  RAISE NOTICE 'TEST (k) PASS: all admin_consume_support_access sub-tests passed';
END;
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- All tests passed
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE '=== ALL SUPPORT_ACCESS_GRANTS RLS TESTS PASSED (T1 + T2) ===';
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
