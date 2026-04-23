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
  v_exc_code  text;
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

  -- Attempt UPDATE as non-admin — must be rejected with 42501 (insufficient_privilege).
  -- WHY assert SQLSTATE and not just v_caught: a trigger failure or FK violation
  -- would also raise WHEN OTHERS but with a different code, causing a false pass.
  -- Asserting 42501 confirms the denial is a genuine RLS / privilege rejection, not
  -- an incidental error that happens to prevent the mutation.
  PERFORM _rls_test_impersonate(v_non_admin);
  BEGIN
    UPDATE public.admin_audit_log SET reason = 'TAMPERED' WHERE actor_id = v_admin;
    -- If we reach here, the UPDATE was not denied — test fails
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (c) FAILED: UPDATE on admin_audit_log was NOT rejected for non-admin';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (c) FAILED: non-admin UPDATE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  -- Also attempt UPDATE as the site admin — should also be denied (REVOKE is absolute)
  PERFORM _rls_test_impersonate(v_admin);
  v_caught   := FALSE;
  v_exc_code := NULL;
  BEGIN
    UPDATE public.admin_audit_log SET reason = 'TAMPERED' WHERE actor_id = v_admin;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    GET STACKED DIAGNOSTICS v_exc_code = RETURNED_SQLSTATE;
  END;

  PERFORM _rls_test_reset_role();

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST (c) FAILED: UPDATE on admin_audit_log was NOT rejected even for site admin';
  END IF;
  IF v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (c) FAILED: site-admin UPDATE raised SQLSTATE %, expected 42501', v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (c) PASS: UPDATE on admin_audit_log raises exception (42501) for both non-admin and site-admin';
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
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (j): admin_override_tier — happy path + authorization (Migration 041)
-- ---------------------------------------------------------------------------
-- WHY: This test confirms all three invariants of admin_override_tier:
--   (j.1) A non-admin caller is rejected with SQLSTATE 42501.
--   (j.2) A site admin can override a tier and the subscription row reflects
--         the new tier, override_source='manual', and correct override_reason.
--   (j.3) The audit log gains a row with correct action, actor, and non-null
--         before_json/after_json.
--   (j.4) An invalid tier value raises SQLSTATE 22023.
--   (j.5) An empty reason raises SQLSTATE 23514.
--
-- SOC2 CC7.2: Authorization enforced + mutation audited in same transaction.
-- OWASP A01:2021: Non-admin cannot call the mutation wrapper.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin         UUID := gen_random_uuid();
  v_non_admin     UUID := gen_random_uuid();
  v_target        UUID := gen_random_uuid();
  v_audit_id      bigint;
  v_tier_after    text;
  v_src_after     text;
  v_expires_after timestamptz;
  v_reason_after  text;
  v_audit_count   int;
  v_action_val    text;
  v_actor_val     uuid;
  v_target_val    uuid;
  v_before_null   boolean;
  v_after_null    boolean;
  v_caught        boolean;
  v_exc_code      text;
BEGIN
  PERFORM _rls_test_reset_role();

  -- Seed three auth users
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,     'admin_j@rls.test',     'x', now(), now()),
      (v_non_admin, 'non_admin_j@rls.test', 'x', now(), now()),
      (v_target,    'target_j@rls.test',    'x', now(), now());

  -- Seed site_admin for v_admin only
  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed j');

  -- Seed a subscriptions row for the target so UPDATE path is exercised
  INSERT INTO public.subscriptions (user_id, tier, override_source)
    VALUES (v_target, 'free', 'polar');

  -- ---- j.1: non-admin caller is rejected (42501) ----
  v_caught := FALSE;
  PERFORM _rls_test_impersonate(v_non_admin);
  BEGIN
    SELECT public.admin_override_tier(
      v_target, 'power', NULL, 'test upgrade', '127.0.0.1'::inet, 'test-ua'
    ) INTO v_audit_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    v_exc_code := SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (j.1) FAILED: expected 42501, got caught=% code=%', v_caught, v_exc_code;
  END IF;

  -- ---- j.2: site admin happy path ----
  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_override_tier(
    v_target, 'power', NULL, 'test upgrade', '10.0.0.1'::inet, 'Mozilla/5.0'
  ) INTO v_audit_id;
  PERFORM _rls_test_reset_role();

  -- Verify subscription row mutation
  SELECT s.tier, s.override_source, s.override_expires_at, s.override_reason
    INTO v_tier_after, v_src_after, v_expires_after, v_reason_after
    FROM public.subscriptions s
    WHERE s.user_id = v_target;

  IF v_tier_after <> 'power' THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: tier = %, expected power', v_tier_after;
  END IF;
  IF v_src_after <> 'manual' THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: override_source = %, expected manual', v_src_after;
  END IF;
  IF v_expires_after IS NOT NULL THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: override_expires_at = %, expected NULL', v_expires_after;
  END IF;
  IF v_reason_after <> 'test upgrade' THEN
    RAISE EXCEPTION 'TEST (j.2) FAILED: override_reason = %, expected ''test upgrade''', v_reason_after;
  END IF;

  -- ---- j.3: audit log row correctness ----
  SELECT count(*),
         max(a.action),
         max(a.actor_id),
         max(a.target_user_id),
         bool_and(a.before_json IS NOT NULL),
         bool_and(a.after_json  IS NOT NULL)
    INTO v_audit_count, v_action_val, v_actor_val, v_target_val, v_before_null, v_after_null
    FROM public.admin_audit_log a
    WHERE a.id = v_audit_id;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: audit row count = %, expected 1', v_audit_count;
  END IF;
  IF v_action_val <> 'override_tier' THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: action = %, expected override_tier', v_action_val;
  END IF;
  IF v_actor_val <> v_admin THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: actor_id mismatch';
  END IF;
  IF v_target_val <> v_target THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: target_user_id mismatch';
  END IF;
  IF NOT v_before_null THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: before_json is NULL (expected non-null — subscription row existed)';
  END IF;
  IF NOT v_after_null THEN
    RAISE EXCEPTION 'TEST (j.3) FAILED: after_json is NULL (expected non-null)';
  END IF;

  -- ---- j.4: invalid tier raises 22023 ----
  v_caught := FALSE;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    SELECT public.admin_override_tier(
      v_target, 'bogus', NULL, 'test reason', '10.0.0.1'::inet, 'ua'
    ) INTO v_audit_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    v_exc_code := SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_exc_code <> '22023' THEN
    RAISE EXCEPTION 'TEST (j.4) FAILED: expected 22023, got caught=% code=%', v_caught, v_exc_code;
  END IF;

  -- ---- j.5: empty reason raises 23514 ----
  v_caught := FALSE;
  PERFORM _rls_test_impersonate(v_admin);
  BEGIN
    SELECT public.admin_override_tier(
      v_target, 'power', NULL, '', '10.0.0.1'::inet, 'ua'
    ) INTO v_audit_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    v_exc_code := SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_exc_code <> '23514' THEN
    RAISE EXCEPTION 'TEST (j.5) FAILED: expected 23514, got caught=% code=%', v_caught, v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (j) PASS: admin_override_tier happy path + authorization all verified';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (k): admin_toggle_consent — grant then revoke cycle (Migration 041)
-- ---------------------------------------------------------------------------
-- WHY: Confirms the four invariants of admin_toggle_consent:
--   (k.1) Site admin grants consent — consent_flags row has granted_at non-null,
--         revoked_at null, granted_by = admin. Audit row written with correct action.
--   (k.2) Site admin revokes consent — same row now has revoked_at non-null.
--         A second audit row is written.
--   (k.3) Non-admin caller is rejected with SQLSTATE 42501.
--   (k.4) Site admin revoke on a target with NO prior consent row is a no-op:
--         consent_flags count stays 0 (no ghost row); audit row IS written with
--         before_json IS NULL and after_json IS NULL.
--
-- SOC2 CC7.2: Every consent change has a corresponding audit trail.
-- GDPR Article 7: Consent revocability requires a working revoke path — tested here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin        UUID := gen_random_uuid();
  v_non_admin    UUID := gen_random_uuid();
  v_target       UUID := gen_random_uuid();
  v_audit_id1    bigint;
  v_audit_id2    bigint;
  v_granted_at   timestamptz;
  v_revoked_at   timestamptz;
  v_granted_by   uuid;
  v_audit_count  int;
  v_action_val   text;
  v_after_val    jsonb;
  v_caught       boolean;
  v_exc_code     text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,     'admin_k@rls.test',     'x', now(), now()),
      (v_non_admin, 'non_admin_k@rls.test', 'x', now(), now()),
      (v_target,    'target_k@rls.test',    'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed k');

  -- ---- k.1: site admin grants consent ----
  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_toggle_consent(
    v_target, 'support_read_metadata', TRUE, 'support ticket #100', '10.0.0.1'::inet, 'ua-k'
  ) INTO v_audit_id1;
  PERFORM _rls_test_reset_role();

  -- Verify consent_flags row state after grant
  SELECT cf.granted_at, cf.revoked_at, cf.granted_by
    INTO v_granted_at, v_revoked_at, v_granted_by
    FROM public.consent_flags cf
    WHERE cf.user_id = v_target
      AND cf.purpose = 'support_read_metadata';

  IF v_granted_at IS NULL THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: granted_at is NULL after grant';
  END IF;
  IF v_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: revoked_at = % after grant, expected NULL', v_revoked_at;
  END IF;
  IF v_granted_by <> v_admin THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: granted_by mismatch (expected admin uuid)';
  END IF;

  -- Verify audit row for the grant
  SELECT count(*), max(a.action), max(a.after_json)
    INTO v_audit_count, v_action_val, v_after_val
    FROM public.admin_audit_log a
    WHERE a.id = v_audit_id1;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: audit row count = %, expected 1', v_audit_count;
  END IF;
  IF v_action_val <> 'toggle_consent' THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: action = %, expected toggle_consent', v_action_val;
  END IF;
  IF v_after_val IS NULL THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: after_json is NULL for grant audit row';
  END IF;
  -- Verify after_json shows the granted state
  IF (v_after_val->>'granted_at') IS NULL THEN
    RAISE EXCEPTION 'TEST (k.1) FAILED: after_json.granted_at is NULL — grant not reflected in audit';
  END IF;

  -- ---- k.2: site admin revokes consent ----
  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_toggle_consent(
    v_target, 'support_read_metadata', FALSE, 'user requested revoke', '10.0.0.1'::inet, 'ua-k'
  ) INTO v_audit_id2;
  PERFORM _rls_test_reset_role();

  -- Verify consent_flags row state after revoke
  SELECT cf.revoked_at
    INTO v_revoked_at
    FROM public.consent_flags cf
    WHERE cf.user_id = v_target
      AND cf.purpose = 'support_read_metadata';

  IF v_revoked_at IS NULL THEN
    RAISE EXCEPTION 'TEST (k.2) FAILED: revoked_at is NULL after revoke';
  END IF;

  -- Verify second audit row was written
  SELECT count(*)
    INTO v_audit_count
    FROM public.admin_audit_log a
    WHERE a.id = v_audit_id2;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (k.2) FAILED: second audit row not found (id=%)', v_audit_id2;
  END IF;

  -- Confirm the two audit IDs are distinct (two separate audit rows were written)
  IF v_audit_id1 = v_audit_id2 THEN
    RAISE EXCEPTION 'TEST (k.2) FAILED: grant and revoke produced same audit id';
  END IF;

  -- ---- k.3: non-admin caller is rejected (42501) ----
  v_caught := FALSE;
  PERFORM _rls_test_impersonate(v_non_admin);
  BEGIN
    SELECT public.admin_toggle_consent(
      v_target, 'support_read_metadata', TRUE, 'unauthorized attempt', '127.0.0.1'::inet, 'ua'
    ) INTO v_audit_id1;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    v_exc_code := SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (k.3) FAILED: expected 42501, got caught=% code=%', v_caught, v_exc_code;
  END IF;

  -- ---- k.4: revoke on a target with NO prior consent row is a no-op mutation ----
  -- WHY: the revoke branch must not insert a ghost row with granted_at = NULL,
  -- revoked_at = <timestamp>. Phase 4.2 UI treats any consent_flags row as evidence
  -- of a past grant event; a ghost row would misrepresent the user's history.
  -- We use a fresh target UUID (v_fresh_target) that has never had a consent row.
  DECLARE
    v_fresh_target  UUID := gen_random_uuid();
    v_audit_id_noop bigint;
    v_ghost_count   int;
    v_before_val    jsonb;
    v_after_val     jsonb;
  BEGIN
    INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
      VALUES (v_fresh_target, 'fresh_k@rls.test', 'x', now(), now());

    -- Confirm no prior consent row exists for this target
    SELECT count(*) INTO v_ghost_count
      FROM public.consent_flags cf
      WHERE cf.user_id = v_fresh_target;

    IF v_ghost_count <> 0 THEN
      RAISE EXCEPTION 'TEST (k.4) SETUP: fresh_target already has % consent rows, expected 0', v_ghost_count;
    END IF;

    -- Site admin attempts to revoke consent that was never granted
    PERFORM _rls_test_impersonate(v_admin);
    SELECT public.admin_toggle_consent(
      v_fresh_target, 'support_read_metadata', FALSE, 'revoke nonexistent', '10.0.0.1'::inet, 'ua-k4'
    ) INTO v_audit_id_noop;
    PERFORM _rls_test_reset_role();

    -- Assert: NO ghost row was inserted into consent_flags
    SELECT count(*) INTO v_ghost_count
      FROM public.consent_flags cf
      WHERE cf.user_id = v_fresh_target;

    IF v_ghost_count <> 0 THEN
      RAISE EXCEPTION 'TEST (k.4) FAILED: % ghost consent_flags row(s) created for nonexistent consent — expected 0', v_ghost_count;
    END IF;

    -- Assert: audit row WAS written with before_json IS NULL and after_json IS NULL
    SELECT a.before_json, a.after_json
      INTO v_before_val, v_after_val
      FROM public.admin_audit_log a
      WHERE a.id = v_audit_id_noop;

    IF v_before_val IS NOT NULL THEN
      RAISE EXCEPTION 'TEST (k.4) FAILED: before_json = % for no-op revoke, expected NULL', v_before_val;
    END IF;
    IF v_after_val IS NOT NULL THEN
      RAISE EXCEPTION 'TEST (k.4) FAILED: after_json = % for no-op revoke, expected NULL', v_after_val;
    END IF;

    -- Cleanup fresh_target auth user
    DELETE FROM auth.users WHERE id = v_fresh_target;
  END;

  RAISE NOTICE 'TEST (k) PASS: admin_toggle_consent grant + revoke cycle + authorization + revoke-nonexistent no-op verified';
END;
$$;

ROLLBACK;
BEGIN;

-- ---------------------------------------------------------------------------
-- Test (l): admin_record_password_reset — audit-only (Migration 041)
-- ---------------------------------------------------------------------------
-- WHY: Confirms the two invariants of admin_record_password_reset:
--   (l.1) Site admin call writes an audit row with action='reset_password',
--         before_json containing email + id, and after_json = NULL.
--         auth.users is NOT mutated (password reset happens app-layer, not here).
--   (l.2) Non-admin caller is rejected with SQLSTATE 42501.
--
-- SOC2 CC7.2: Password reset events are audited before execution.
-- OWASP A09:2021: Every admin password reset action is logged with IP and UA.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin        UUID := gen_random_uuid();
  v_non_admin    UUID := gen_random_uuid();
  v_target       UUID := gen_random_uuid();
  v_target_email text := 'target_l@rls.test';
  v_audit_id     bigint;
  v_action_val   text;
  v_before_val   jsonb;
  v_after_val    jsonb;
  v_audit_count  int;
  v_before_email text;
  v_before_id    text;
  v_auth_email_before text;
  v_auth_email_after  text;
  v_caught       boolean;
  v_exc_code     text;
BEGIN
  PERFORM _rls_test_reset_role();

  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,     'admin_l@rls.test',   'x', now(), now()),
      (v_non_admin, 'nonadmin_l@rls.test','x', now(), now()),
      (v_target,    v_target_email,        'x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'rls test seed l');

  -- ---- l.1: site admin happy path ----
  -- Capture auth.users email before the call to verify no mutation happened.
  SELECT u.email INTO v_auth_email_before
    FROM auth.users u WHERE u.id = v_target;

  PERFORM _rls_test_impersonate(v_admin);
  SELECT public.admin_record_password_reset(
    v_target, 'user requested reset via email', '10.0.0.1'::inet, 'Mozilla/5.0'
  ) INTO v_audit_id;
  PERFORM _rls_test_reset_role();

  -- Verify auth.users was NOT mutated (password reset is app-layer)
  SELECT u.email INTO v_auth_email_after
    FROM auth.users u WHERE u.id = v_target;

  IF v_auth_email_before IS DISTINCT FROM v_auth_email_after THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: auth.users.email changed — function should not mutate auth.users';
  END IF;

  -- Verify audit row content
  SELECT count(*), max(a.action), max(a.before_json), max(a.after_json)
    INTO v_audit_count, v_action_val, v_before_val, v_after_val
    FROM public.admin_audit_log a
    WHERE a.id = v_audit_id;

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: audit row count = %, expected 1', v_audit_count;
  END IF;
  IF v_action_val <> 'reset_password' THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: action = %, expected reset_password', v_action_val;
  END IF;
  IF v_after_val IS NOT NULL THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: after_json = %, expected NULL (audit-only function)', v_after_val;
  END IF;
  IF v_before_val IS NULL THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: before_json is NULL — expected auth.users snapshot';
  END IF;

  -- Verify before_json contains id and email fields
  v_before_id    := v_before_val->>'id';
  v_before_email := v_before_val->>'email';

  IF v_before_id IS NULL OR v_before_id::uuid <> v_target THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: before_json.id = %, expected %', v_before_id, v_target;
  END IF;
  IF v_before_email IS NULL OR v_before_email <> v_target_email THEN
    RAISE EXCEPTION 'TEST (l.1) FAILED: before_json.email = %, expected %', v_before_email, v_target_email;
  END IF;

  -- ---- l.2: non-admin caller is rejected (42501) ----
  v_caught := FALSE;
  PERFORM _rls_test_impersonate(v_non_admin);
  BEGIN
    SELECT public.admin_record_password_reset(
      v_target, 'unauthorized attempt', '127.0.0.1'::inet, 'ua'
    ) INTO v_audit_id;
  EXCEPTION WHEN OTHERS THEN
    v_caught   := TRUE;
    v_exc_code := SQLSTATE;
  END;
  PERFORM _rls_test_reset_role();

  IF NOT v_caught OR v_exc_code <> '42501' THEN
    RAISE EXCEPTION 'TEST (l.2) FAILED: expected 42501, got caught=% code=%', v_caught, v_exc_code;
  END IF;

  RAISE NOTICE 'TEST (l) PASS: admin_record_password_reset audit-only behavior + authorization verified';
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
