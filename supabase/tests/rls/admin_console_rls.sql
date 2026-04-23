-- ============================================================================
-- RLS TEST SUITE: Migration 040 (Admin Console)
-- ============================================================================
-- Validates the security invariants of migration 040_admin_console.sql.
--
-- USAGE (local):
--   supabase db reset               # applies all migrations 001-040
--   psql "$DB_URL" -f supabase/tests/rls/admin_console_rls.sql
--
-- Exit semantics:
--   - Each test block is wrapped in BEGIN ... ROLLBACK to avoid polluting state.
--   - RAISE EXCEPTION aborts the script at the first failing assertion.
--   - Success = script runs to completion with "ALL RLS TESTS PASSED" notice.
--
-- Security invariants under test (per spec §6 T1 success criteria):
--   (a) Non-admin authenticated user cannot SELECT admin_audit_log rows
--   (b) Non-admin authenticated user cannot SELECT site_admins rows (except self)
--   (c) UPDATE on admin_audit_log raises an exception (no policy + explicit REVOKE)
--   (d) verify_admin_audit_chain() returns ('ok', NULL, 0) on an empty table
--   (e) is_site_admin(uid) returns false for a user not in site_admins
--   (f) Site admin CAN SELECT admin_audit_log rows for the full set
--   (g) consent_flags: non-admin can only see their own rows; site admin sees all
--
-- SOC2 CC7.2: Logical access control enforced at the database layer via RLS.
-- OWASP A01:2021 – Broken Access Control mitigated by Postgres-level deny-by-default.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Test harness helpers (idempotent re-creation in case they exist from other
-- test suites — these run in the same session as prior test files if loaded
-- together via psql \i).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _rls_test_impersonate(p_uid UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- WHY: set_config with is_local=true scopes the change to the current
  -- transaction, so it automatically reverts on ROLLBACK. This lets each
  -- test block start clean without an explicit reset call.
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

BEGIN;

-- ---------------------------------------------------------------------------
-- Test (a): Non-admin cannot SELECT admin_audit_log
-- ---------------------------------------------------------------------------
-- WHY: An authenticated user who is NOT in site_admins must receive zero rows
-- from admin_audit_log even when a row exists. This enforces the SOC2 CC7.2
-- principle of least privilege: normal users have no business seeing admin ops.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_non_admin UUID := gen_random_uuid();
  v_admin     UUID := gen_random_uuid();
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Insert fixtures via superuser (bypasses RLS)
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_non_admin, 'non_admin_a@rls.test', 'x', now(), now()),
      (v_admin,     'admin_a@rls.test',     'x', now(), now());

  -- Seed a site_admin row for v_admin only
  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- Insert one audit log row via service-role (direct insert, trigger fires)
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_non_admin, 'override_tier', 'test seed', '0', '0');

  -- Impersonate the non-admin and count visible audit rows
  PERFORM _rls_test_impersonate(v_non_admin);
  SELECT count(*) INTO v_visible_count FROM public.admin_audit_log;

  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'TEST (a) FAILED: non-admin sees % audit rows, expected 0', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (a) PASS: non-admin cannot SELECT admin_audit_log';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (b): Non-admin cannot SELECT site_admins rows other than their own
-- ---------------------------------------------------------------------------
-- WHY: site_admins contains the admin allowlist. A non-admin user must never
-- be able to enumerate other admins — that would be an information leak that
-- aids targeted attacks. The self-lookup exception lets a user check their own
-- admin status without a separate API call.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user_a UUID := gen_random_uuid();
  v_admin  UUID := gen_random_uuid();
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_user_a, 'user_a_b@rls.test', 'x', now(), now()),
      (v_admin,  'admin_b@rls.test',  'x', now(), now());

  -- Only v_admin is in site_admins
  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- As v_user_a (non-admin): should see 0 rows (their own uid is not in the table)
  PERFORM _rls_test_impersonate(v_user_a);
  SELECT count(*) INTO v_visible_count FROM public.site_admins;

  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: non-admin sees % site_admins rows, expected 0', v_visible_count;
  END IF;

  -- Now confirm a site_admin CAN see their own row (self-access clause)
  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_visible_count FROM public.site_admins;

  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST (b) FAILED: site_admin sees % rows in site_admins, expected 1', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (b) PASS: non-admin cannot SELECT site_admins rows other than self; site_admin sees self row';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (c): UPDATE on admin_audit_log raises exception (tamper resistance)
-- ---------------------------------------------------------------------------
-- WHY: The audit log is append-only by design. Even if an attacker has
-- authenticated access, they must not be able to alter audit entries.
-- RLS blocks update by default (no UPDATE policy), and we also REVOKE UPDATE
-- explicitly from PUBLIC/authenticated/anon to guard against future grant
-- regressions (defense-in-depth per OWASP A01 / SOC2 CC7.2).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID := gen_random_uuid();
  v_non_admin UUID := gen_random_uuid();
  v_caught    BOOLEAN := FALSE;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,     'admin_c@rls.test',     'x', now(), now()),
      (v_non_admin, 'non_admin_c@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- Seed an audit log row
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_non_admin, 'reset_password', 'test seed', '0', '0');

  -- Attempt UPDATE as non-admin — must be rejected
  PERFORM _rls_test_impersonate(v_non_admin);
  BEGIN
    UPDATE public.admin_audit_log SET reason = 'TAMPERED' WHERE actor_id = v_admin;
    -- If we reach here, the UPDATE was not denied — test fails
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (c) FAILED: UPDATE on admin_audit_log was NOT rejected for non-admin';
  END IF;

  -- Also attempt UPDATE as the site admin — should also be denied (REVOKE is absolute)
  PERFORM _rls_test_impersonate(v_admin);
  v_caught := FALSE;
  BEGIN
    UPDATE public.admin_audit_log SET reason = 'TAMPERED' WHERE actor_id = v_admin;
  EXCEPTION WHEN OTHERS THEN
    v_caught := TRUE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (c) FAILED: UPDATE on admin_audit_log was NOT rejected even for site admin';
  END IF;

  RAISE NOTICE 'TEST (c) PASS: UPDATE on admin_audit_log raises exception for both non-admin and site-admin';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (d): verify_admin_audit_chain() returns ('ok', NULL, 0) on empty table
-- ---------------------------------------------------------------------------
-- WHY: The genesis state of the hash chain (empty table) must produce a clean
-- verification result. If verify_admin_audit_chain() errors or returns a
-- mismatch on an empty table, the chain logic is broken before any rows exist.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin UUID := gen_random_uuid();
  v_status text;
  v_broken_id bigint;
  v_total_rows bigint;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES (v_admin, 'admin_d@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- Call as site admin (verify_admin_audit_chain checks is_site_admin internally)
  PERFORM _rls_test_impersonate(v_admin);

  SELECT v.status, v.first_broken_id, v.total_rows
    INTO v_status, v_broken_id, v_total_rows
    FROM public.verify_admin_audit_chain() AS v;

  PERFORM _rls_test_reset_role();

  IF v_status <> 'ok' THEN
    RAISE EXCEPTION 'TEST (d) FAILED: verify_admin_audit_chain status = %, expected ok', v_status;
  END IF;
  IF v_broken_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST (d) FAILED: verify_admin_audit_chain first_broken_id = %, expected NULL', v_broken_id;
  END IF;
  IF v_total_rows <> 0 THEN
    RAISE EXCEPTION 'TEST (d) FAILED: verify_admin_audit_chain total_rows = %, expected 0', v_total_rows;
  END IF;

  RAISE NOTICE 'TEST (d) PASS: verify_admin_audit_chain returns (ok, NULL, 0) on empty table';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (e): is_site_admin() returns false for non-admin user
-- ---------------------------------------------------------------------------
-- WHY: Confirming the base case — a user not in site_admins must never be
-- considered an admin, even if the table happens to be empty.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user UUID := gen_random_uuid();
  v_result BOOLEAN;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES (v_user, 'plain_e@rls.test', 'x', now(), now());

  -- Do NOT insert into site_admins
  SELECT public.is_site_admin(v_user) INTO v_result;

  IF v_result <> FALSE THEN
    RAISE EXCEPTION 'TEST (e) FAILED: is_site_admin returned true for non-admin user';
  END IF;

  RAISE NOTICE 'TEST (e) PASS: is_site_admin returns false for non-admin user';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (f): Site admin CAN SELECT all admin_audit_log rows
-- ---------------------------------------------------------------------------
-- WHY: Site admins need to review the full audit trail. This confirms the
-- SELECT policy grants them access once they are in site_admins.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID := gen_random_uuid();
  v_non_admin UUID := gen_random_uuid();
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,     'admin_f@rls.test',     'x', now(), now()),
      (v_non_admin, 'non_admin_f@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- Seed two audit rows (both triggered by the admin)
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_non_admin, 'override_tier',   'seed row 1', '0', '0'),
    (v_admin, v_non_admin, 'reset_password',  'seed row 2', '0', '0');

  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_visible_count FROM public.admin_audit_log;

  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 2 THEN
    RAISE EXCEPTION 'TEST (f) FAILED: site admin sees % audit rows, expected 2', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (f) PASS: site admin can SELECT all admin_audit_log rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (g): consent_flags — non-admin sees only own rows; site admin sees all
-- ---------------------------------------------------------------------------
-- WHY: consent_flags drives Phase 4.2 support-read access. Users must only
-- see their own consent state; the admin dossier view requires all.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin     UUID := gen_random_uuid();
  v_user_a    UUID := gen_random_uuid();
  v_user_b    UUID := gen_random_uuid();
  v_visible_count INT;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,  'admin_g@rls.test',  'x', now(), now()),
      (v_user_a, 'user_ga@rls.test',  'x', now(), now()),
      (v_user_b, 'user_gb@rls.test',  'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed');

  -- Insert a consent flag for each user
  INSERT INTO public.consent_flags (user_id, purpose, granted_at, granted_by, note)
    VALUES
      (v_user_a, 'support_read_metadata', now(), v_admin, 'user a consent'),
      (v_user_b, 'support_read_metadata', now(), v_admin, 'user b consent');

  -- v_user_a should only see their own row
  PERFORM _rls_test_impersonate(v_user_a);
  SELECT count(*) INTO v_visible_count FROM public.consent_flags;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'TEST (g) FAILED: user_a sees % consent rows, expected 1', v_visible_count;
  END IF;

  -- v_admin should see all rows
  PERFORM _rls_test_impersonate(v_admin);
  SELECT count(*) INTO v_visible_count FROM public.consent_flags;
  PERFORM _rls_test_reset_role();

  IF v_visible_count <> 2 THEN
    RAISE EXCEPTION 'TEST (g) FAILED: site admin sees % consent rows, expected 2', v_visible_count;
  END IF;

  RAISE NOTICE 'TEST (g) PASS: consent_flags non-admin sees self only; site admin sees all';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (h): Hash chain behavioral test — insert, verify clean, tamper, verify broken
-- ---------------------------------------------------------------------------
-- WHY: This is the core security promise of the migration. We must confirm that:
--   1. Three sequential INSERTs produce a valid chain (verify returns 'ok').
--   2. Direct UPDATE of a row's reason field (simulating an attacker with DB
--      access who bypasses RLS) is detected as 'row_hash_mismatch' at the
--      tampered row's id.
-- Without this test, the hash chain is unproven tamper-evidence.
-- SOC2 CC7.2: Tamper-evident audit logs require behavioral verification.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin         UUID := gen_random_uuid();
  v_target        UUID := gen_random_uuid();
  v_row1_id       bigint;
  v_row2_id       bigint;
  v_row3_id       bigint;
  v_status        text;
  v_broken_id     bigint;
  v_total_rows    bigint;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Setup: seed auth users and site_admin row
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,  'admin_h@rls.test',  'x', now(), now()),
      (v_target, 'target_h@rls.test', 'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed h');

  -- Insert 3 audit rows via service role (superuser context, bypasses RLS).
  -- The BEFORE INSERT trigger admin_audit_chain_hash fires and computes correct
  -- prev_hash and row_hash for each row.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_target, 'override_tier',    'seed h row 1', '0', '0')
  RETURNING id INTO v_row1_id;

  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_target, 'toggle_consent',   'seed h row 2', '0', '0')
  RETURNING id INTO v_row2_id;

  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_target, 'reset_password',   'seed h row 3', '0', '0')
  RETURNING id INTO v_row3_id;

  -- Step 1: verify chain is intact (3 rows, no tampering)
  PERFORM _rls_test_impersonate(v_admin);

  SELECT v.status, v.first_broken_id, v.total_rows
    INTO v_status, v_broken_id, v_total_rows
    FROM public.verify_admin_audit_chain() AS v;

  PERFORM _rls_test_reset_role();

  IF v_status <> 'ok' THEN
    RAISE EXCEPTION 'TEST (h.1) FAILED: chain status = %, expected ok', v_status;
  END IF;
  IF v_broken_id IS NOT NULL THEN
    RAISE EXCEPTION 'TEST (h.1) FAILED: first_broken_id = %, expected NULL', v_broken_id;
  END IF;
  IF v_total_rows <> 3 THEN
    RAISE EXCEPTION 'TEST (h.1) FAILED: total_rows = %, expected 3', v_total_rows;
  END IF;

  -- Step 2: tamper with the middle row as superuser (simulates attacker with direct DB access).
  -- WHY: UPDATE is REVOKEd from all app roles, but superuser can always bypass.
  -- This proves the hash chain catches tampering even at the superuser level.
  UPDATE public.admin_audit_log
    SET reason = 'TAMPERED BY ATTACKER'
    WHERE id = v_row2_id;

  -- Step 3: verify chain now reports tamper at the middle row
  PERFORM _rls_test_impersonate(v_admin);

  SELECT v.status, v.first_broken_id, v.total_rows
    INTO v_status, v_broken_id, v_total_rows
    FROM public.verify_admin_audit_chain() AS v;

  PERFORM _rls_test_reset_role();

  IF v_status <> 'row_hash_mismatch' THEN
    RAISE EXCEPTION 'TEST (h.2) FAILED: chain status = %, expected row_hash_mismatch', v_status;
  END IF;
  IF v_broken_id <> v_row2_id THEN
    RAISE EXCEPTION 'TEST (h.2) FAILED: first_broken_id = %, expected %', v_broken_id, v_row2_id;
  END IF;
  IF v_total_rows <> 2 THEN
    -- total_rows is the count of rows inspected before (and including) the broken one
    RAISE EXCEPTION 'TEST (h.2) FAILED: total_rows = %, expected 2', v_total_rows;
  END IF;

  -- Cleanup: remove test rows as superuser
  DELETE FROM public.admin_audit_log WHERE id IN (v_row1_id, v_row2_id, v_row3_id);
  DELETE FROM public.site_admins WHERE user_id = v_admin;
  DELETE FROM auth.users WHERE id IN (v_admin, v_target);

  RAISE NOTICE 'TEST (h) PASS: hash chain detects tamper at middle row; clean chain verified at 3 rows';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (i): verify_admin_audit_chain() raises 'not authorized' for non-admin
-- ---------------------------------------------------------------------------
-- WHY: An unauthenticated or non-admin user must NOT be able to probe the hash
-- chain state. If they could, they could determine whether tampering has been
-- detected (e.g. to know whether their cover-up succeeded). The SECURITY DEFINER
-- function must enforce authorization regardless of external GRANT state.
-- OWASP A01: Function-level access control must not be bypassable.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_non_admin UUID := gen_random_uuid();
  v_caught    BOOLEAN := FALSE;
  v_exc_msg   text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES (v_non_admin, 'non_admin_i@rls.test', 'x', now(), now());

  -- Impersonate a plain authenticated user (not in site_admins)
  PERFORM _rls_test_impersonate(v_non_admin);

  BEGIN
    -- This call must raise 'not authorized' from inside verify_admin_audit_chain
    PERFORM public.verify_admin_audit_chain();
    -- If we reach here, the function did not raise — test fails
  EXCEPTION WHEN OTHERS THEN
    v_caught  := TRUE;
    v_exc_msg := SQLERRM;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (i) FAILED: verify_admin_audit_chain() did not raise for non-admin user';
  END IF;

  IF v_exc_msg NOT ILIKE '%not authorized%' THEN
    RAISE EXCEPTION 'TEST (i) FAILED: exception message = %, expected it to contain "not authorized"', v_exc_msg;
  END IF;

  -- Cleanup
  DELETE FROM auth.users WHERE id = v_non_admin;

  RAISE NOTICE 'TEST (i) PASS: verify_admin_audit_chain raises "not authorized" for non-admin caller';
END;
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- All tests passed
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE '=== ALL ADMIN CONSOLE RLS TESTS PASSED ===';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test harness cleanup — drop helper functions so they don't pollute the schema
-- ---------------------------------------------------------------------------
-- WHY: _rls_test_impersonate and _rls_test_reset_role are test-only helpers.
-- Leaving them in the DB creates an unnecessary attack surface (a malicious
-- caller could invoke them to elevate apparent role context). Dropping them
-- here ensures a clean schema after the test suite runs.
DROP FUNCTION IF EXISTS _rls_test_impersonate(UUID);
DROP FUNCTION IF EXISTS _rls_test_reset_role();
