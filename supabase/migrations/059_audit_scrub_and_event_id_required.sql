-- Migration 059: audit metadata PII scrub + idempotency event-id contract enforcement
--
-- Closes two findings from /sec-ship --comprehensive run #2 (2026-04-25):
--   * SEC-ADV-R2-003 (MEDIUM 5/10) — audit_trigger_fn on churn_save_offers
--     stores polar_discount_code into user-readable audit_log; user can
--     exfiltrate the coupon via GDPR export.
--   * SEC-ADV-R2-004 (LOW-MEDIUM 4/10) — admin_idempotency_check_with_event
--     silently degrades to minute-bucket dedup when p_event_id is NULL,
--     re-exposing the audit-row collapse bug it was specifically built to
--     prevent.
--
-- ────────────────────────────────────────────────────────────────────────────
-- PART 1 — audit_trigger_fn: per-table sensitive-key scrub
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT: replace audit_trigger_fn (last set in migration 058 with bigserial
--   compatibility). Add a final step before the audit_log INSERT that strips
--   sensitive columns from metadata.record on a per-table allowlist basis.
--
-- WHY THIS APPROACH (table-keyed scrub vs. column-level RLS or denormalised
-- metadata):
--   - Table-keyed scrub is the smallest behaviour change. The audit_log row
--     keeps existing semantics; only the offending sub-key disappears.
--   - Column-level RLS would require splitting metadata into multiple jsonb
--     paths and gating each — heavier surgery.
--   - Denormalising to a separate audit_record_metadata table would change
--     query patterns across every existing audit consumer.
--
--   The scrub pattern is extensible: future tables that want to track
--   mutations but avoid leaking secrets can be added to the same case.
--
-- TABLES SCRUBBED:
--   churn_save_offers — strip polar_discount_code (Polar coupon string).
--     Audit retains the offer kind / discount_pct / duration / accepted_at
--     so SOC2 CC7.2 reconstruction works; only the raw coupon code is gone.
--
-- COMPATIBILITY: idempotent (CREATE OR REPLACE). Bigserial-PK handling from
--   migration 058 is preserved verbatim.

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
  IF (TG_OP = 'DELETE') THEN
    v_record := to_jsonb(OLD);
  ELSIF (TG_OP = 'UPDATE') THEN
    v_record := to_jsonb(NEW);
  ELSIF (TG_OP = 'INSERT') THEN
    v_record := to_jsonb(NEW);
  END IF;

  IF v_record ? 'user_id' THEN
    BEGIN
      v_user_id := (v_record->>'user_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_user_id := NULL;
    END;
  ELSE
    v_user_id := NULL;
  END IF;

  -- bigserial-PK compatibility (migration 058) — preserved unchanged.
  BEGIN
    v_resource_id := (v_record->>'id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_resource_id := NULL;
  END;

  -- SEC-ADV-R2-003 scrub: drop sensitive columns from per-table allowlist
  -- BEFORE the metadata.record INSERT so the user-accessible audit_log path
  -- (and the GDPR export path that reads audit_log) cannot leak them.
  --
  -- Currently scrubbed:
  --   * churn_save_offers.polar_discount_code — Polar coupon code; the user
  --     would otherwise receive the raw code via GET /api/account/export.
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

-- ────────────────────────────────────────────────────────────────────────────
-- PART 2 — admin_idempotency_check_with_event: require non-NULL event_id
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT: replace the helper from migration 056. Drop the silent fallback that
--   collapsed NULL p_event_id to '' and degraded to minute-bucket dedup
--   (which is the very bug R2-IDEM was meant to fix).
--
-- WHY THROW INSTEAD OF FALLBACK:
--   The helper exists specifically because the older minute-bucket dedup
--   collapsed two distinct billing events into one audit row. Falling back
--   to that same behaviour for NULL inputs re-creates the original bug class
--   silently. Failing loud forces the caller to either: (a) supply a real
--   event id (the contract), or (b) explicitly call the OLDER helper if
--   they want minute-bucket semantics.
--
-- CALLER IMPACT: admin_issue_refund (migration 056) is the sole caller. Its
--   Polar webhook event-id is sourced from refund.id, which Polar's SDK
--   guarantees is non-null on success. The idempotent-replay path (set in
--   actions.ts) supplies the literal string 'idempotent-replay' — also
--   non-null. So no legitimate caller passes NULL today; the throw is
--   strictly defensive.

CREATE OR REPLACE FUNCTION public.admin_idempotency_check_with_event(
  p_actor_user_id uuid,
  p_action_name text,
  p_target_user_id uuid,
  p_reason text,
  p_event_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_lock_key bigint;
  v_existing bigint;
BEGIN
  -- SEC-ADV-R2-004 — fail-loud on NULL or empty event id. The caller MUST
  -- supply a real correlation token; without it we'd silently collapse
  -- distinct billing events into a single audit row.
  IF p_event_id IS NULL OR btrim(p_event_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'admin_idempotency_check_with_event: p_event_id must be non-null and non-empty (use admin_idempotency_check for minute-bucket semantics)';
  END IF;

  v_lock_key := hashtextextended(
    p_actor_user_id::text || '|' || p_action_name || '|' ||
    COALESCE(p_target_user_id::text, '') || '|' ||
    COALESCE(btrim(p_reason), '') || '|' || btrim(p_event_id),
    0
  );

  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT id INTO v_existing
  FROM admin_audit_log
  WHERE actor_user_id = p_actor_user_id
    AND action = p_action_name
    AND COALESCE(target_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(p_target_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND after_json->>'polar_event_id' = btrim(p_event_id)
  ORDER BY id ASC
  LIMIT 1;

  RETURN v_existing;
END;
$$;

-- Preserve EXECUTE grant (matches the original from migration 056).
GRANT EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(uuid, text, uuid, text, text) TO authenticated;
