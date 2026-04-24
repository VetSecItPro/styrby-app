-- Migration 052: Repair migration 018's audit_trigger_fn and re-enable triggers.
--
-- HISTORY:
--   Migration 018 (shipped weeks ago) attached audit_log_* triggers to five
--   tables: profiles, subscriptions, api_keys, team_members, team_policies.
--   The trigger function had three independent latent bugs that prevented
--   it from firing successfully:
--
--     1. Column-name mismatch: INSERTed into audit_log using 'details',
--        actual column is 'metadata' (migration 001 line 755). SQLSTATE 42703.
--     2. Type cast mismatch: (v_record->>'id')::text inserted into
--        audit_log.resource_id (uuid). No implicit text→uuid cast. SQLSTATE 42804.
--     3. Enum incompatibility: TG_OP::text::audit_action cast 'INSERT' /
--        'UPDATE' / 'DELETE' to an enum of domain events (login,
--        subscription_changed, etc.) — none of which are DML op verbs.
--        SQLSTATE 22P02.
--
--   The triggers were effectively dormant in production (any mutation of an
--   audited table would have crashed with 42703 first). Migration 0395
--   (hotfix 2026-04-23) disabled them when Phase 4.1's migration 040 UPDATE
--   on subscriptions started surfacing the failure.
--
-- REPAIR APPROACH:
--   Option (b) from the backlog entry — map TG_OP-agnostic DML events to a
--   single new domain event 'record_mutated' rather than extending the
--   audit_action enum with DML op names. Reasoning:
--     * audit_action is a domain-event enum (login, session_created,
--       subscription_changed, ...). Adding 'INSERT'/'UPDATE'/'DELETE' would
--       muddy the semantic clarity of existing values.
--     * Auditors query by domain event, not by DML op. TG_OP is still
--       captured in metadata JSONB for drilldown.
--     * One enum addition is minimum-viable; fits the existing taxonomy.
--
-- WHAT THIS MIGRATION DOES:
--   1. Extends audit_action enum with 'record_mutated'.
--   2. CREATE OR REPLACE audit_trigger_fn with all three bugs fixed.
--   3. Re-enables the five triggers that migration 0395 disabled.
--
-- Governing: SOC2 CC7.2 (audit logging correctness).

-- ============================================================================
-- 1. Extend audit_action enum
-- ============================================================================

-- WHY IF NOT EXISTS: migration is idempotent on re-run; ALTER TYPE ADD VALUE
-- commits outside the transaction so the guard prevents re-add errors.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'record_mutated';

-- ============================================================================
-- 2. CREATE OR REPLACE audit_trigger_fn with all three bugs fixed
-- ============================================================================

-- WHY CREATE OR REPLACE: the function signature is unchanged; all existing
-- triggers referencing it carry forward to the new body automatically.
-- SECURITY DEFINER preserved so the function runs as its owner (postgres)
-- and can INSERT into audit_log regardless of the calling user's grants.
--
-- Fixes applied:
--   - 'details' → 'metadata' (column name matches migration 001 line 755)
--   - (v_record->>'id')::text → (v_record->>'id')::uuid (matches audit_log.resource_id type)
--   - TG_OP::text::audit_action → 'record_mutated'::audit_action (uses the new enum value;
--     actual DML op preserved in metadata JSONB for drilldown)
--
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
  -- Extract the row snapshot: on DELETE use OLD; otherwise NEW.
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
    metadata,                          -- FIXED: was 'details' (column does not exist; actual column is metadata)
    created_at
  ) VALUES (
    -- WHY COALESCE to auth.uid(): row may have its own user_id (for
    -- service-role writes like billing webhooks). auth.uid() fallback
    -- captures the authenticated caller when the row has no user column.
    COALESCE(v_user_id, auth.uid()),

    -- FIXED: was TG_OP::text::audit_action (enum has no DML op values).
    -- 'record_mutated' covers all INSERT/UPDATE/DELETE for audited tables;
    -- actual op preserved in metadata JSONB below for drilldown.
    'record_mutated'::audit_action,

    -- TG_TABLE_NAME is the unqualified table name (e.g. 'profiles').
    TG_TABLE_NAME,

    -- FIXED: was (v_record->>'id')::text cast into uuid column (42804).
    -- Cast to uuid directly. All five audited tables use uuid 'id' columns.
    -- If a future audited table uses a non-uuid id, this will raise 22P02
    -- at the boundary — intentional: surface the incompatibility rather
    -- than silently drop the audit event.
    CASE
      WHEN TG_OP = 'DELETE' THEN (v_record->>'id')::uuid
      ELSE (v_record->>'id')::uuid
    END,

    -- Full row snapshot as JSONB. Captures TG_OP so auditors can filter
    -- by INSERT / UPDATE / DELETE without a separate enum.
    jsonb_build_object(
      'operation', TG_OP,                      -- INSERT / UPDATE / DELETE
      'table', TG_TABLE_NAME,
      'record', v_record,
      'control_ref', 'SOC2 CC7.2'
    ),

    now()
  );

  -- AFTER triggers on non-STATEMENT events ignore the return value; NULL
  -- makes intent explicit: observe, don't modify.
  RETURN NULL;
END;
$$;

-- Owner-default grants are correct for SECURITY DEFINER; no explicit GRANT
-- needed (function owner is postgres via the migration).

-- ============================================================================
-- 3. Re-enable the five triggers that migration 0395 disabled
-- ============================================================================

-- WHY re-enable now: the function body no longer crashes on DML mutations
-- of the five audited tables. Migration 0395's disable was defensive during
-- the latent-bug period. This restoration closes the SOC2 CC7.2 audit gap.

ALTER TABLE public.profiles      ENABLE TRIGGER audit_log_profiles;
ALTER TABLE public.subscriptions ENABLE TRIGGER audit_log_subscriptions;
ALTER TABLE public.api_keys      ENABLE TRIGGER audit_log_api_keys;

-- team_members and team_policies were conditionally attached in migration 018.
-- Use DO block to probe pg_trigger and skip when absent (handles environments
-- where the parent tables don't exist yet).
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
-- 4. Self-test — verify the trigger works end-to-end
-- ============================================================================
--
-- This DO block triggers audit_trigger_fn by updating a user row, then
-- checks that audit_log received the event with the correct metadata shape.
-- Fails the migration apply if the trigger is still broken.

DO $$
DECLARE
  v_test_user_id uuid := '00000000-0000-0000-0000-000000052001';
  v_audit_count_before bigint;
  v_audit_count_after bigint;
  v_last_action text;
  v_last_metadata jsonb;
BEGIN
  -- Seed a test user only if not already present.
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at, email_confirmed_at)
  VALUES (v_test_user_id,
          'migration_052_test@styrby.internal',
          '$fake',
          now(),
          now(),
          now())
  ON CONFLICT (id) DO NOTHING;

  -- handle_new_user trigger should create a profiles row; ensure one exists
  INSERT INTO public.profiles (id, display_name)
  VALUES (v_test_user_id, 'migration 052 test')
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- Baseline
  SELECT count(*) INTO v_audit_count_before FROM public.audit_log;

  -- Trigger: UPDATE the profiles row. This fires audit_log_profiles.
  UPDATE public.profiles SET display_name = 'migration 052 test (updated)' WHERE id = v_test_user_id;

  -- Verify one new audit row appeared with action='record_mutated'
  SELECT count(*) INTO v_audit_count_after FROM public.audit_log;

  IF v_audit_count_after < v_audit_count_before + 1 THEN
    RAISE EXCEPTION 'MIGRATION 052 TEST FAILED: expected >= 1 new audit_log row after UPDATE, got delta=%',
      v_audit_count_after - v_audit_count_before;
  END IF;

  SELECT action::text, metadata
  INTO v_last_action, v_last_metadata
  FROM public.audit_log
  WHERE resource_type = 'profiles' AND resource_id = v_test_user_id
  ORDER BY created_at DESC LIMIT 1;

  IF v_last_action <> 'record_mutated' THEN
    RAISE EXCEPTION 'MIGRATION 052 TEST FAILED: expected action=record_mutated, got %', v_last_action;
  END IF;

  IF v_last_metadata->>'operation' <> 'UPDATE' THEN
    RAISE EXCEPTION 'MIGRATION 052 TEST FAILED: expected metadata.operation=UPDATE, got %', v_last_metadata->>'operation';
  END IF;

  IF v_last_metadata->>'table' <> 'profiles' THEN
    RAISE EXCEPTION 'MIGRATION 052 TEST FAILED: expected metadata.table=profiles, got %', v_last_metadata->>'table';
  END IF;

  -- Cleanup: remove test rows (cascades via profiles FK).
  DELETE FROM public.audit_log WHERE resource_id = v_test_user_id;
  DELETE FROM auth.users WHERE id = v_test_user_id;

  RAISE NOTICE 'MIGRATION 052 TEST PASSED: audit_trigger_fn fires correctly with record_mutated action + UPDATE op in metadata';
END;
$$;
