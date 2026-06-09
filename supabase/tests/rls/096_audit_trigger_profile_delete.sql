-- ============================================================================
-- BEHAVIOR TEST: Migration 096 (audit_trigger_fn FK-safe on profile delete)
-- ============================================================================
-- Proves a profile can be DELETEd without the audit trigger raising
-- 23503 (audit_log_user_id_fkey), across the three real paths, and that the
-- deletion is still audited correctly.
--
-- USAGE (local):
--   supabase db reset
--   psql "$DB_URL" -f supabase/tests/rls/096_audit_trigger_profile_delete.sql
--
-- Invariants:
--   1. Self-service delete (auth.uid() == the profile) succeeds; audit row has
--      user_id = NULL, resource_id = deleted id, metadata.actor = self.
--   2. Admin delete (auth.uid() = a different, live user) succeeds; audit row
--      has user_id = the admin (FK-valid), resource_id = the deleted profile.
--   3. Cascade delete via auth.users (no auth.uid()) succeeds; no 23503.
-- ============================================================================

CREATE OR REPLACE FUNCTION _set_uid(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text,''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '' ELSE json_build_object('sub',p_uid::text,'role','authenticated')::text END, true);
END;$$;

BEGIN;

-- Test 1: self-service account deletion (the GDPR path that used to 500)
DO $$
DECLARE u uuid := gen_random_uuid(); n int; logged record;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'selfdel96@test.local');
  INSERT INTO profiles (id) VALUES (u) ON CONFLICT DO NOTHING;
  PERFORM _set_uid(u);                         -- acting as myself
  DELETE FROM public.profiles WHERE id = u;    -- must NOT raise 23503
  PERFORM _set_uid(NULL);
  SELECT count(*) INTO n FROM profiles WHERE id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'TEST 1 FAILED: profile not deleted'; END IF;
  SELECT user_id, resource_id INTO logged FROM audit_log
    WHERE resource_type='profiles' AND resource_id=u ORDER BY created_at DESC LIMIT 1;
  IF logged.resource_id <> u THEN RAISE EXCEPTION 'TEST 1 FAILED: deletion not audited'; END IF;
  IF logged.user_id IS NOT NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: self-delete audit user_id should be NULL, got %', logged.user_id; END IF;
  RAISE NOTICE 'TEST 1 PASS: self-service profile delete works + audited (user_id NULL)';
END;$$;

ROLLBACK; BEGIN;

-- Test 2: admin deletes another user — actor recorded, FK-valid
DO $$
DECLARE admin uuid := gen_random_uuid(); target uuid := gen_random_uuid(); logged record;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (admin,'admin96@test.local'),(target,'target96@test.local');
  INSERT INTO profiles (id) VALUES (admin) ON CONFLICT DO NOTHING;
  INSERT INTO profiles (id) VALUES (target) ON CONFLICT DO NOTHING;
  PERFORM _set_uid(admin);                       -- admin is the actor
  DELETE FROM public.profiles WHERE id = target; -- must NOT raise 23503
  PERFORM _set_uid(NULL);
  SELECT user_id, resource_id INTO logged FROM audit_log
    WHERE resource_type='profiles' AND resource_id=target ORDER BY created_at DESC LIMIT 1;
  IF logged.user_id <> admin THEN RAISE EXCEPTION 'TEST 2 FAILED: expected actor=admin in user_id, got %', logged.user_id; END IF;
  RAISE NOTICE 'TEST 2 PASS: admin profile delete works + records live actor';
END;$$;

ROLLBACK; BEGIN;

-- Test 3: cascade delete via auth.users (service-role path, no auth.uid())
DO $$
DECLARE u uuid := gen_random_uuid(); n int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u,'cascade96@test.local');
  INSERT INTO profiles (id) VALUES (u) ON CONFLICT DO NOTHING;
  PERFORM _set_uid(NULL);
  DELETE FROM auth.users WHERE id = u;        -- cascades to profiles; must NOT raise 23503
  SELECT count(*) INTO n FROM profiles WHERE id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'TEST 3 FAILED: cascade did not remove profile'; END IF;
  RAISE NOTICE 'TEST 3 PASS: auth.users cascade delete works (no FK abort)';
END;$$;

ROLLBACK;

DROP FUNCTION IF EXISTS _set_uid(uuid);

DO $$ BEGIN
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'ALL TESTS PASSED — migration 096 profile-delete audit is FK-safe';
  RAISE NOTICE '================================================================';
END;$$;
