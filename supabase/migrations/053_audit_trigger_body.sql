-- Migration 053: audit_trigger_fn body repair + re-enable triggers + self-test.
--
-- Prerequisite: migration 052 added 'record_mutated' to the audit_action enum
-- in a separate transaction (Postgres 55P04 workaround — ADD VALUE cannot be
-- referenced in the same transaction that created it).
--
-- HISTORY: migration 018's audit_trigger_fn had 3 independent latent bugs
-- (details column, uuid cast, audit_action enum mismatch). Migration 0395
-- disabled the 5 triggers as a hotfix. This migration fixes the function
-- body, re-enables the triggers, and validates via inline self-test.
--
-- Governing: SOC2 CC7.2.

-- ============================================================================
-- 1. CREATE OR REPLACE audit_trigger_fn with all three bugs fixed
-- ============================================================================

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record jsonb;
  v_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record := to_jsonb(OLD);
    BEGIN
      v_user_id := (OLD).user_id;
    EXCEPTION WHEN others THEN
      v_user_id := NULL;
    END;
  ELSE
    v_record := to_jsonb(NEW);
    BEGIN
      v_user_id := (NEW).user_id;
    EXCEPTION WHEN others THEN
      v_user_id := NULL;
    END;
  END IF;

  INSERT INTO public.audit_log (
    user_id,
    action,
    resource_type,
    resource_id,
    metadata,
    created_at
  ) VALUES (
    COALESCE(v_user_id, auth.uid()),
    'record_mutated'::audit_action,
    TG_TABLE_NAME,
    CASE
      WHEN TG_OP = 'DELETE' THEN (v_record->>'id')::uuid
      ELSE (v_record->>'id')::uuid
    END,
    jsonb_build_object(
      'operation', TG_OP,
      'table', TG_TABLE_NAME,
      'record', v_record,
      'control_ref', 'SOC2 CC7.2'
    ),
    now()
  );

  RETURN NULL;
END;
$$;

-- ============================================================================
-- 2. Re-enable the 5 triggers migration 0395 disabled
-- ============================================================================

ALTER TABLE public.profiles      ENABLE TRIGGER audit_log_profiles;
ALTER TABLE public.subscriptions ENABLE TRIGGER audit_log_subscriptions;
ALTER TABLE public.api_keys      ENABLE TRIGGER audit_log_api_keys;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_team_members' AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.team_members ENABLE TRIGGER audit_log_team_members;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_team_policies' AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.team_policies ENABLE TRIGGER audit_log_team_policies;
  END IF;
END $$;

-- ============================================================================
-- 3. Self-test: verify the trigger works end-to-end
-- ============================================================================

DO $$
DECLARE
  v_test_user_id uuid := '00000000-0000-0000-0000-000000053001';
  v_audit_count_before bigint;
  v_audit_count_after bigint;
  v_last_action text;
  v_last_metadata jsonb;
BEGIN
  -- Seed auth.users + profiles
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at, email_confirmed_at)
  VALUES (v_test_user_id,
          'migration_053_test@styrby.internal',
          '$fake',
          now(),
          now(),
          now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, display_name)
  VALUES (v_test_user_id, 'migration 053 test')
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  SELECT count(*) INTO v_audit_count_before FROM public.audit_log;

  UPDATE public.profiles SET display_name = 'migration 053 test (updated)' WHERE id = v_test_user_id;

  SELECT count(*) INTO v_audit_count_after FROM public.audit_log;

  IF v_audit_count_after < v_audit_count_before + 1 THEN
    RAISE EXCEPTION 'MIGRATION 053 TEST FAILED: expected >= 1 new audit_log row after UPDATE, got delta=%',
      v_audit_count_after - v_audit_count_before;
  END IF;

  SELECT action::text, metadata
  INTO v_last_action, v_last_metadata
  FROM public.audit_log
  WHERE resource_type = 'profiles' AND resource_id = v_test_user_id
  ORDER BY created_at DESC LIMIT 1;

  IF v_last_action <> 'record_mutated' THEN
    RAISE EXCEPTION 'MIGRATION 053 TEST FAILED: expected action=record_mutated, got %', v_last_action;
  END IF;

  IF v_last_metadata->>'operation' <> 'UPDATE' THEN
    RAISE EXCEPTION 'MIGRATION 053 TEST FAILED: expected metadata.operation=UPDATE, got %', v_last_metadata->>'operation';
  END IF;

  IF v_last_metadata->>'table' <> 'profiles' THEN
    RAISE EXCEPTION 'MIGRATION 053 TEST FAILED: expected metadata.table=profiles, got %', v_last_metadata->>'table';
  END IF;

  -- Cleanup
  DELETE FROM public.audit_log WHERE resource_id = v_test_user_id;
  DELETE FROM auth.users WHERE id = v_test_user_id;

  RAISE NOTICE 'MIGRATION 053 TEST PASSED: audit_trigger_fn fires with record_mutated action + UPDATE op in metadata';
END;
$$;
