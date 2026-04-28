-- Migration 061: Add 'growth' to tier allowlists in admin_override_tier and
-- apply_polar_subscription_with_override_check RPCs.
--
-- WHY: Phase 5/6 cutover added the canonical Growth tier (migration 060 added
-- the enum value), but the inline allowlists in two SECURITY DEFINER RPCs
-- (migrations 041 and 045) still rejected 'growth' with ERRCODE 22023
-- ("invalid tier value"). This caused EVERY Polar webhook event for a Growth
-- subscription to fail at the RPC layer in production, returning 500 to the
-- webhook handler and leaving prod tier state out of sync with reality.
--
-- Surfaced by sandbox e2e domain C and I (subscription tier upgrades to
-- growth, growth-tier base subscriptions, growth revoke). Confirmed in dev
-- log: `shouldHonorManualOverride: RPC rejected p_new_tier (ERRCODE 22023)
-- - invalid tier value bypassed Node-layer filter`.
--
-- APPROACH:
--   1. New helper `_is_billable_tier(text)` centralizes the allowlist so
--      future tier additions only touch one place.
--   2. CREATE OR REPLACE both functions with bodies that call the helper.
--      Function bodies are otherwise verbatim from migrations 041 and 045 —
--      only the allowlist check changes.
--
-- ROLLBACK: re-run migrations 041 and 045 to restore the legacy allowlist.
--
-- Risk class: SAFE — both functions are SECURITY DEFINER and idempotent;
-- replacing them does not require ALTER TABLE locks. The change is purely
-- additive (allows one more value); existing callers using legacy tiers
-- still pass the check.
-- ============================================================================

-- §1. Allowlist helper
-- WHY IMMUTABLE PARALLEL SAFE: the function is a pure literal lookup with no
-- side effects; the planner can fold the call into its containing CHECK or IF
-- and run it in any worker. Marking it explicitly avoids unnecessary
-- repermissioning during query planning.

CREATE OR REPLACE FUNCTION public._is_billable_tier(t text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT t IN ('free', 'pro', 'power', 'team', 'business', 'enterprise', 'growth');
$$;

COMMENT ON FUNCTION public._is_billable_tier(text) IS
  'Tier allowlist for SECURITY DEFINER RPCs. Includes legacy + canonical tiers.';

-- §2. admin_override_tier — body replicated from 041 §3.5.1 with helper call.
CREATE OR REPLACE FUNCTION public.admin_override_tier(
  p_target_user_id  uuid,
  p_new_tier        text,
  p_expires_at      timestamptz,
  p_reason          text,
  p_ip              inet,
  p_ua              text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_before   jsonb;
  v_after    jsonb;
  v_audit_id bigint;
BEGIN
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Migration 061: allowlist now includes 'growth' via _is_billable_tier helper.
  IF NOT public._is_billable_tier(p_new_tier) THEN
    RAISE EXCEPTION 'invalid tier value' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  SELECT to_jsonb(s.*) INTO v_before
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  UPDATE public.subscriptions
    SET tier               = p_new_tier,
        override_source    = 'manual',
        override_expires_at = p_expires_at,
        override_reason    = p_reason,
        updated_at         = now()
    WHERE user_id = p_target_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.subscriptions (user_id, tier, override_source, override_expires_at, override_reason)
      VALUES (p_target_user_id, p_new_tier, 'manual', p_expires_at, p_reason);
  END IF;

  SELECT to_jsonb(s.*) INTO v_after
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason, ip, user_agent)
  VALUES
    (v_actor, p_target_user_id, 'override_tier', 'subscriptions', v_before, v_after, p_reason, p_ip, p_ua)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_override_tier(uuid, text, timestamptz, text, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_override_tier(uuid, text, timestamptz, text, inet, text) TO authenticated;

-- §3. apply_polar_subscription_with_override_check — body replicated from 045 §4
-- with helper call. Body identical except for the allowlist line.
CREATE OR REPLACE FUNCTION public.apply_polar_subscription_with_override_check(
  p_user_id                uuid,
  p_new_tier               text,
  p_polar_subscription_id  text,
  p_billing_cycle          text,
  p_current_period_end     timestamptz,
  p_polar_event_id         text
)
RETURNS TABLE (decision text, expires_at timestamptz, previous_actor uuid, audit_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_override_source     text;
  v_override_expires_at timestamptz;
  v_previous_actor      uuid;
  v_before_json         jsonb;
  v_after_json          jsonb;
  v_audit_id            bigint;
BEGIN
  -- Migration 061: allowlist now includes 'growth' via _is_billable_tier helper.
  IF NOT public._is_billable_tier(p_new_tier) THEN
    RAISE EXCEPTION 'invalid tier value' USING ERRCODE = '22023';
  END IF;

  SELECT s.override_source, s.override_expires_at
    INTO v_override_source, v_override_expires_at
    FROM public.subscriptions s
    WHERE s.user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'polar_source'::text, NULL::timestamptz, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;

  IF v_override_source = 'manual'
     AND (v_override_expires_at IS NULL OR v_override_expires_at > now()) THEN
    RETURN QUERY SELECT 'manual_override_active'::text, v_override_expires_at, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;

  IF v_override_source = 'manual' AND v_override_expires_at <= now() THEN

    SELECT actor_id INTO v_previous_actor
      FROM public.admin_audit_log
      WHERE target_user_id = p_user_id
        AND action = 'override_tier'
      ORDER BY id DESC
      LIMIT 1;

    SELECT to_jsonb(s.*) INTO v_before_json
      FROM public.subscriptions s
      WHERE s.user_id = p_user_id;

    UPDATE public.subscriptions
      SET tier                 = p_new_tier,
          polar_subscription_id = p_polar_subscription_id,
          billing_cycle         = p_billing_cycle,
          current_period_end    = p_current_period_end,
          override_source       = 'polar',
          override_expires_at   = NULL,
          updated_at            = now()
      WHERE user_id = p_user_id;

    SELECT to_jsonb(s.*) INTO v_after_json
      FROM public.subscriptions s
      WHERE s.user_id = p_user_id;

    INSERT INTO public.admin_audit_log
      (actor_id, target_user_id, action, target_entity,
       before_json, after_json, reason, ip, user_agent)
    VALUES
      (v_previous_actor, p_user_id, 'manual_override_expired', 'subscriptions',
       v_before_json, v_after_json,
       'Polar webhook auto-expired manual override after override_expires_at (polar_event_id='
         || COALESCE(p_polar_event_id, 'null') || ')',
       NULL, 'polar-webhook')
    RETURNING id INTO v_audit_id;

    RETURN QUERY SELECT 'override_expired'::text, v_override_expires_at, v_previous_actor, v_audit_id;
    RETURN;
  END IF;

  -- Polar-sourced subscription (override_source = 'polar' or unrecognized).
  RETURN QUERY SELECT 'polar_source'::text, NULL::timestamptz, NULL::uuid, NULL::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_polar_subscription_with_override_check(uuid, text, text, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(uuid, text, text, text, timestamptz, text) TO authenticated, service_role;
