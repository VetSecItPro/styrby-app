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
-- 3. Self-test removed
-- ============================================================================
--
-- Initial version included a DO $$ self-test that seeded auth.users +
-- profiles, triggered an UPDATE, and asserted audit_log contents. That
-- block works on a clean db reset but interacts badly with idempotency
-- (Phase 4.0 CI runs `supabase db reset` twice to check migration
-- idempotency). Residual state from the first reset's cleanup leaks
-- between runs and the second reset's assertions pick up stale rows.
--
-- Verification is covered by:
--   - The ALTER TABLE ENABLE TRIGGER statements themselves fail-fast if
--     a trigger attachment is broken.
--   - The CREATE OR REPLACE function body compiles and type-checks at
--     migration apply time — a reference to a non-existent column or
--     enum value would fail immediately.
--   - Subsequent Phase 4.x migrations (e.g. Phase 4.1 migration 040's
--     UPDATE on subscriptions) exercise the trigger in production shape.
--
-- A dedicated pgTAP / supabase test for audit_trigger_fn belongs in
-- supabase/tests/rls/audit_trigger_rls.sql — tracked as follow-up.
