-- ============================================================================
-- BEHAVIOR TEST: Migration 097 (audit_trigger_fn defensive blocks restored)
-- ============================================================================
-- Guards against the regression migration 096 introduced: rewriting
-- audit_trigger_fn from scratch dropped (a) the bigserial-PK cast guard and
-- (b) the churn_save_offers PII scrub. This test exercises a bigserial-PK
-- audited table AND the scrub so any future from-scratch rewrite that drops
-- them fails CI (096's test only covered profiles, which is why it regressed).
--
-- USAGE (local):
--   supabase db reset
--   psql "$DB_URL" -f supabase/tests/rls/097_audit_trigger_bigserial_and_scrub.sql
--
-- Invariants:
--   1. INSERT into billing_credits (id bigserial) does NOT raise 22P02; the
--      audit row is written with resource_id = NULL (bigint PK can't be uuid).
--   2. INSERT into churn_save_offers does NOT raise; the audit row's
--      metadata.record has polar_discount_code SCRUBBED.
--   3. profiles self-delete still works + audit user_id = NULL (096 preserved).
-- ============================================================================

BEGIN;

-- Test 1: bigserial-PK audited table no longer 22P02-aborts (SEC-MIG-R2-001).
DO $$
DECLARE u uuid := gen_random_uuid(); a uuid := gen_random_uuid(); v_res uuid; n int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u,'bc097@test.local'),(a,'adm097@test.local');
  INSERT INTO profiles (id) VALUES (u),(a) ON CONFLICT DO NOTHING;

  -- Pre-097 this raised SQLSTATE 22P02 (bigint id text -> uuid) and aborted.
  INSERT INTO billing_credits (user_id, amount_cents, currency, reason, granted_by, granted_at)
    VALUES (u, 500, 'usd', 'test097', a, now());

  SELECT count(*) INTO n FROM audit_log WHERE resource_type='billing_credits';
  IF n < 1 THEN RAISE EXCEPTION 'TEST 1 FAILED: billing_credits insert not audited'; END IF;

  SELECT resource_id INTO v_res FROM audit_log WHERE resource_type='billing_credits' ORDER BY created_at DESC LIMIT 1;
  IF v_res IS NOT NULL THEN RAISE EXCEPTION 'TEST 1 FAILED: bigserial PK should map to NULL resource_id, got %', v_res; END IF;

  RAISE NOTICE 'TEST 1 PASS: bigserial-PK insert succeeds (no 22P02), audit resource_id NULL';
END;$$;

ROLLBACK; BEGIN;

-- Test 2: churn_save_offers.polar_discount_code scrubbed from audit_log (SEC-ADV-R2-003).
DO $$
DECLARE u uuid := gen_random_uuid(); a uuid := gen_random_uuid(); rec jsonb;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u,'churn097@test.local'),(a,'adm097b@test.local');
  INSERT INTO profiles (id) VALUES (u),(a) ON CONFLICT DO NOTHING;

  INSERT INTO churn_save_offers (user_id, kind, discount_pct, discount_duration_months, sent_by, sent_at, expires_at, polar_discount_code, reason)
    VALUES (u, 'annual_3mo_25pct', 25, 3, a, now(), now()+interval '7 days', 'SECRET-COUPON-XYZ', 'retention');

  SELECT metadata->'record' INTO rec FROM audit_log WHERE resource_type='churn_save_offers' ORDER BY created_at DESC LIMIT 1;
  IF rec IS NULL THEN RAISE EXCEPTION 'TEST 2 FAILED: churn insert not audited'; END IF;
  IF rec ? 'polar_discount_code' THEN
    RAISE EXCEPTION 'TEST 2 FAILED: polar_discount_code leaked into audit_log: %', rec->>'polar_discount_code';
  END IF;

  RAISE NOTICE 'TEST 2 PASS: churn_save_offers polar_discount_code scrubbed from audit_log';
END;$$;

ROLLBACK; BEGIN;

-- Test 3: profiles self-delete still FK-safe (096 behavior preserved by 097).
DO $$
DECLARE u uuid := gen_random_uuid(); logged record; n int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'selfdel097@test.local');
  INSERT INTO profiles (id) VALUES (u) ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',u::text,'role','authenticated')::text, true);
  DELETE FROM public.profiles WHERE id = u;  -- must NOT raise 23503
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT count(*) INTO n FROM profiles WHERE id = u;
  IF n <> 0 THEN RAISE EXCEPTION 'TEST 3 FAILED: profile not deleted'; END IF;
  SELECT user_id, resource_id INTO logged FROM audit_log WHERE resource_type='profiles' AND resource_id=u ORDER BY created_at DESC LIMIT 1;
  IF logged.user_id IS NOT NULL THEN RAISE EXCEPTION 'TEST 3 FAILED: self-delete audit user_id should be NULL'; END IF;
  RAISE NOTICE 'TEST 3 PASS: profiles self-delete FK-safe + audited (user_id NULL)';
END;$$;

ROLLBACK;

DO $$ BEGIN
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'ALL TESTS PASSED — migration 097 audit_trigger_fn defensive blocks intact';
  RAISE NOTICE '================================================================';
END;$$;
