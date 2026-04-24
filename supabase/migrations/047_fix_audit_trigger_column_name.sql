-- ============================================================================
-- Migration 047: Fix audit_trigger_fn — column "details" → "metadata"
-- ============================================================================
-- Date:    2026-04-23
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/daemon-error-recovery-ux-2026-04-21
--
-- Bug ref:
--   Migration 018 (audit_trigger_fn) referenced column "details" in the
--   INSERT into public.audit_log. The actual column name (migration 001
--   line 755) is "metadata" (JSONB). The function body was syntactically
--   valid at creation time because CREATE OR REPLACE validates only PL/pgSQL
--   syntax, not table column references — those are resolved at runtime.
--
-- How it surfaced:
--   The trigger was latently broken since migration 018 shipped. No prior
--   migration fired the function in a way that reached the INSERT. Migration
--   045's DO $$ block performs a test INSERT into auth.users, which cascades:
--     auth.users INSERT
--       → handle_new_user() trigger (Supabase built-in)
--         → profiles INSERT
--           → audit_trigger_fn()  ← SQLSTATE 42703 "column 'details' does not exist"
--   This caused the Postgres migration CI job to exit 1.
--
-- Fix:
--   CREATE OR REPLACE the function body with the single change:
--     "details" → "metadata"
--   All other logic is byte-for-byte identical to migration 018.
--   CREATE OR REPLACE preserves all triggers that reference the function —
--   no trigger DDL is required here.
--
-- Governing standard: SOC2 CC7.2 (audit logging correctness).
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID;
  v_record   JSONB;
BEGIN
  -- WHY: For DELETE we log OLD (the row that was removed). For INSERT and
  -- UPDATE we log NEW (the row as it now exists). This mirrors standard
  -- audit-log practice: the "what happened" record is the new/removed state.
  IF TG_OP = 'DELETE' THEN
    v_record := to_jsonb(OLD);
    -- WHY: Attempt to extract user_id from the deleted row so the audit entry
    -- is owner-attributed. Falls back to NULL if the column doesn't exist on
    -- this table (handled by the EXCEPTION block below).
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

  INSERT INTO audit_log (
    user_id,
    action,
    resource_type,
    resource_id,
    metadata,            -- FIX: was "details" (non-existent column); actual column is "metadata" (migration 001 line 755)
    created_at
  ) VALUES (
    -- WHY: Prefer the row's own user_id. If the trigger fires from a
    -- service-role operation (e.g. billing webhook updating subscriptions),
    -- the row's user_id is the affected user — correct for audit attribution.
    -- Falls back to auth.uid() if the row has no user_id column.
    COALESCE(v_user_id, auth.uid()),

    -- WHY: Cast TG_OP to audit_action via text. TG_OP values are 'INSERT',
    -- 'UPDATE', 'DELETE' — which must exist in the audit_action enum.
    -- If they don't, this cast will raise a DB error and the migration should
    -- be updated to add the missing enum values first.
    TG_OP::text::audit_action,

    -- WHY: TG_TABLE_NAME is the unqualified table name (e.g. 'profiles').
    -- This is consistent with how other audit_log entries record resource_type.
    TG_TABLE_NAME,

    -- WHY: Try to extract 'id' as the resource identifier. Most Styrby tables
    -- use UUID primary key named 'id'. EXCEPTION block handles tables without it.
    CASE
      WHEN TG_OP = 'DELETE' THEN (v_record->>'id')::text
      ELSE (v_record->>'id')::text
    END,

    -- WHY: Store the full row snapshot as JSONB in metadata. This lets auditors
    -- reconstruct the exact state at the time of mutation, including which
    -- fields changed on UPDATE. No PII scrubbing here — audit_log is a
    -- high-privilege table with service-role access only (SOC2 requirement).
    jsonb_build_object(
      'operation', TG_OP,
      'table',     TG_TABLE_NAME,
      'record',    v_record,
      'control_ref', 'SOC2 CC7.2'
    ),

    now()
  );

  -- WHY: For AFTER triggers, the return value is ignored for non-STATEMENT
  -- triggers. We return NULL here as the canonical form; returning NEW or OLD
  -- would also work but NULL makes the intent explicit: we are observing, not
  -- modifying the row.
  RETURN NULL;
END;
$$;

-- ============================================================================
-- END OF MIGRATION 047
-- ============================================================================
