-- Migration 096: Make audit_trigger_fn FK-safe on profile deletion.
--
-- ROOT-CAUSE BUG:
--   audit_log.user_id has FK -> profiles(id) ON DELETE SET NULL (migration 001).
--   audit_trigger_fn (migration 053) fires AFTER DELETE on profiles and inserts
--   an audit row with user_id = COALESCE((OLD).user_id, auth.uid()). For a
--   profiles DELETE the resolved id is the profile being deleted (profiles.id ==
--   the user id; and during a GoTrue admin/self delete auth.uid() is that same
--   id). The profile row is already gone by the time the AFTER-DELETE trigger
--   inserts, so the new audit row references a non-existent profile and the
--   INSERT raises SQLSTATE 23503 (audit_log_user_id_fkey) — which ABORTS the
--   whole deletion.
--
--   Impact: ANY profile deletion 500s — admin user deletion AND, critically,
--   the self-service GDPR "delete my account" flow. (Surfaced 2026-06-09 while
--   removing leaked e2e test users from production.)
--
--   This is profiles-specific: for every other audited table a DELETE's
--   user_id points at the OWNER's profile, and in an auth.users cascade the
--   child rows are deleted BEFORE the parent profile, so the owner still
--   exists when their audit row is written. profiles is the only table whose
--   audited row IS the FK target.
--
-- FIX:
--   On a profiles DELETE, set the audit row's user_id to
--   NULLIF(auth.uid(), OLD.id):
--     - admin deletes another user  -> auth.uid() = admin (a live profile) -> recorded
--     - user deletes own account    -> auth.uid() = OLD.id                 -> NULL
--     - service-role cascade delete -> auth.uid() = NULL                   -> NULL
--   user_id = NULL is permitted by the column + FK. The deleted profile's id
--   and full snapshot are still captured in resource_id + metadata.record, and
--   the acting principal is recorded in metadata.actor — so the deletion audit
--   is preserved without a dangling FK.
--
--   All non-profiles behavior is unchanged.
--
-- Governing: SOC2 CC7.2 (audit completeness) + GDPR Art.17 (erasure must work).

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record jsonb;
  v_user_id uuid;       -- subject (owner) id read off the row, if it has one
  v_final_user_id uuid; -- FK-safe value actually written to audit_log.user_id
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

  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'profiles' THEN
    -- The subject profile is being deleted; never reference it. Record the
    -- actor only when it is a DIFFERENT, still-existing user (admin delete);
    -- otherwise NULL (self-deletion / service-role cascade). FK-safe always.
    v_final_user_id := NULLIF(auth.uid(), (v_record->>'id')::uuid);
  ELSE
    v_final_user_id := COALESCE(v_user_id, auth.uid());
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
    (v_record->>'id')::uuid,
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
