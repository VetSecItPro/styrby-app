-- Migration 058: audit_trigger_fn — BIGSERIAL PK COMPATIBILITY HOTFIX (SEC-MIG-R2-001)
--
-- BUG SURFACED BY:
--   /sec-ship --comprehensive (run #2, 2026-04-25). See
--   .security-reports/scanner-migrations-r2.md → SEC-MIG-R2-001 (HIGH 8/10).
--
-- THE BUG:
--   Migration 056 attached audit_trigger_fn to three Phase 4 tables whose
--   primary keys are bigserial:
--     - public.billing_credits           (id bigserial PRIMARY KEY)
--     - public.churn_save_offers         (id bigserial PRIMARY KEY)
--     - public.support_access_grants     (id bigserial PRIMARY KEY)
--
--   audit_trigger_fn (migration 053, lines 56–57) unconditionally executes:
--     resource_id := (v_record->>'id')::uuid
--
--   The cast fails with SQLSTATE 22P02 (invalid_text_representation) for any
--   bigint value. Postgres aborts the surrounding transaction, meaning every
--   INSERT / UPDATE / DELETE on those three tables fails — admin_issue_credit,
--   admin_send_churn_save_offer, admin_request_support_access, user_approve /
--   user_revoke / admin_consume support access, all become 22P02 errors.
--
--   No production damage observed yet because no admin workflow has fired in
--   the ~5h since migration 056 was applied to prod. This hotfix lands before
--   any of those flows are exercised.
--
-- WHY THE 5 ORIGINAL TABLES (profiles, subscriptions, api_keys, team_members,
-- team_policies) WORK:
--   They all have UUID primary keys, so the ::uuid cast succeeds. Migration
--   053's function body was authored for those tables exclusively — the cast
--   was implicitly safe. Migration 056 broadened attachment without adapting
--   the body, surfacing this latent assumption.
--
-- THE FIX (single CREATE OR REPLACE FUNCTION):
--   Wrap the cast in BEGIN/EXCEPTION WHEN invalid_text_representation. On
--   failure, set resource_id := NULL. The full row (including the bigserial id)
--   is already preserved in metadata.record (line 64 of the inherited body),
--   so audit forensics retain the id under metadata.record.id; the resource_id
--   column simply moves from "always populated" to "populated only for tables
--   with a UUID id column" — which is consistent with the column's NULLABLE
--   constraint (verified via information_schema 2026-04-25).
--
-- SAFETY PROPERTIES:
--   - Idempotent: CREATE OR REPLACE FUNCTION is safe to re-run.
--   - Backward-compatible: the 5 UUID-PK tables continue to write resource_id
--     identically to before this migration.
--   - No data migration required: existing audit_log rows are unchanged. Only
--     future INSERTs differ for the 3 bigserial-PK tables.
--   - No trigger detach/reattach required: the function body changes; the
--     existing trigger bindings keep pointing at the same function name.
--   - Compatible with Phase 4.0 CI's `supabase db reset` twice-per-PR check.
--
-- Governing controls: SOC2 CC7.2 (audit-trail integrity preserved across all
--   tracked tables, with bigserial ids visible via metadata.record.id).

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_record jsonb;
  v_user_id uuid;
  v_resource_id uuid;
BEGIN
  -- Reproduce the inherited body from migration 053 verbatim, except we
  -- capture v_resource_id via a defensive cast so non-UUID PK columns
  -- degrade gracefully rather than aborting the host transaction.

  IF (TG_OP = 'DELETE') THEN
    v_record := to_jsonb(OLD);
  ELSIF (TG_OP = 'UPDATE') THEN
    v_record := to_jsonb(NEW);
  ELSIF (TG_OP = 'INSERT') THEN
    v_record := to_jsonb(NEW);
  END IF;

  -- Extract a user_id from the record if the table has one. The 5 UUID-PK
  -- tables typically expose user_id; the bigserial-PK tables also do (we
  -- verified billing_credits, churn_save_offers, support_access_grants all
  -- have a user_id uuid column referencing auth.users(id)).
  IF v_record ? 'user_id' THEN
    BEGIN
      v_user_id := (v_record->>'user_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_user_id := NULL;
    END;
  ELSE
    v_user_id := NULL;
  END IF;

  -- WHY EXCEPTION wrapper here (this is the SEC-MIG-R2-001 fix):
  -- The 5 originally-attached tables (profiles/subscriptions/api_keys/
  -- team_members/team_policies) have UUID primary keys, so this cast
  -- succeeds. The 3 Phase-4 tables attached in migration 056 have bigserial
  -- PKs; the cast would otherwise raise 22P02 and abort the host
  -- transaction. We catch the specific cast error and fall back to NULL.
  -- The bigint id remains visible to auditors via metadata->'record'->>'id'.
  BEGIN
    v_resource_id := (v_record->>'id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_resource_id := NULL;
  END;

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
    v_resource_id,
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

-- The 8 trigger bindings from migrations 053 + 056 keep working unchanged.
-- No GRANT changes needed (function is SECURITY DEFINER, called by triggers).
