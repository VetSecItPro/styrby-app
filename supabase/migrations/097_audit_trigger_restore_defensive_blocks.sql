-- Migration 097: Restore the audit_trigger_fn defensive blocks that migration
-- 096 dropped when it rewrote the function body from scratch.
--
-- REGRESSION (introduced by migration 096, found 2026-06-09 by the bug-hunt audit):
--   096 reimplemented audit_trigger_fn to make profile deletion FK-safe, but in
--   rewriting the whole body it silently dropped two defensive blocks that
--   migrations 058 + 059 had added:
--
--     1. (058 — SEC-MIG-R2-001, HIGH) bigserial-PK compatibility. resource_id
--        was cast `(v_record->>'id')::uuid` INSIDE a BEGIN/EXCEPTION wrapper,
--        because billing_credits, churn_save_offers, and support_access_grants
--        have `id bigserial` PRIMARY KEYs (migrations 048/050) and are audited
--        (migration 056). 096 cast inline with NO guard, so the first write to
--        any of those tables raises SQLSTATE 22P02 (invalid_text_representation,
--        "invalid input syntax for type uuid") and ABORTS the host transaction.
--        Impact: admin_issue_credit, admin_send_churn_save_offer, and every
--        support_access_grant flow (request/approve/revoke/consume) 500.
--
--     2. (059 — SEC-ADV-R2-003, HIGH) PII scrub. churn_save_offers.polar_discount_code
--        was stripped from metadata.record BEFORE the INSERT, because audit_log
--        is owner-readable (RLS) and is exported verbatim via
--        GET /api/account/export. 096 dropped the scrub, so every churn-save-offer
--        mutation leaks the raw Polar coupon code into the user-accessible audit
--        trail + GDPR export.
--
--   096 also narrowed search_path from (public, extensions, pg_temp) to
--   (public, pg_temp); this migration restores `extensions` to match 059.
--
-- FIX: re-merge BOTH defensive blocks while PRESERVING 096's profile-delete
-- FK-safe user_id handling (user_id = NULLIF(auth.uid(), OLD.id) on a profiles
-- DELETE, so the audit row never references the just-deleted profile).
--
-- Governing: SOC2 CC7.2 (audit completeness/integrity) + GDPR Art.17 (erasure)
-- + the SEC-MIG-R2-001 / SEC-ADV-R2-003 controls 058/059 established.

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_record jsonb;
  v_user_id uuid;        -- subject (owner) id read off the row, if it has one
  v_final_user_id uuid;  -- FK-safe value written to audit_log.user_id (096)
  v_resource_id uuid;    -- bigserial-safe value written to audit_log.resource_id (058)
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

  -- (096) profiles is the only audited table whose row IS the FK target of
  -- audit_log.user_id. On a profiles DELETE never reference the just-deleted
  -- profile: record the actor only when it is a DIFFERENT, still-existing user
  -- (admin delete); otherwise NULL (self-deletion / service-role cascade).
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'profiles' THEN
    v_final_user_id := NULLIF(auth.uid(), (v_record->>'id')::uuid);
  ELSE
    v_final_user_id := COALESCE(v_user_id, auth.uid());
  END IF;

  -- (058) bigserial-PK compatibility. billing_credits / churn_save_offers /
  -- support_access_grants have `id bigserial` PKs; casting a bigint id's text
  -- to uuid raises 22P02. Guard the cast and store NULL for non-uuid PKs so the
  -- audit INSERT never aborts the host transaction.
  BEGIN
    v_resource_id := (v_record->>'id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_resource_id := NULL;
  END;

  -- (059, SEC-ADV-R2-003) scrub sensitive columns from the per-table allowlist
  -- BEFORE the metadata.record INSERT, since audit_log is owner-readable (RLS)
  -- and is exported via GET /api/account/export.
  --   * churn_save_offers.polar_discount_code — Polar coupon code.
  IF TG_TABLE_NAME = 'churn_save_offers' THEN
    v_record := v_record - 'polar_discount_code';
  END IF;

  INSERT INTO public.audit_log (
    user_id,
    action,
    resource_type,
    resource_id,
    metadata,
    created_at
  ) VALUES (
    v_final_user_id,
    'record_mutated'::audit_action,
    TG_TABLE_NAME,
    v_resource_id,
    jsonb_build_object(
      'operation', TG_OP,
      'table', TG_TABLE_NAME,
      'record', v_record,
      'actor', auth.uid(),
      'control_ref', 'SOC2 CC7.2'
    ),
    now()
  );

  RETURN NULL;
END;
$$;
