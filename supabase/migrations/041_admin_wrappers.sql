-- ============================================================================
-- Migration 041: Admin Console — SECURITY DEFINER Mutation Wrappers (Phase 4.1)
--
-- Creates THREE SECURITY DEFINER wrapper functions that encapsulate all admin
-- mutations so they are impossible without is_site_admin(auth.uid()) = true,
-- regardless of which route or SDK path calls them.
--
-- Functions created:
--   1. admin_override_tier(p_target_user_id, p_new_tier, p_expires_at, p_reason, p_ip, p_ua)
--   2. admin_toggle_consent(p_target_user_id, p_purpose, p_grant, p_reason, p_ip, p_ua)
--   3. admin_record_password_reset(p_target_user_id, p_reason, p_ip, p_ua)
--
-- Security model summary (all three functions share this pattern):
--   - SECURITY DEFINER: function body executes with definer privileges so it
--     can INSERT into admin_audit_log and UPDATE consent_flags / subscriptions
--     without granting those table-level privileges to the 'authenticated' role.
--   - SET search_path = public, extensions, pg_temp: prevents search-path
--     injection (a malicious user creating a shadow function in a writable schema).
--     'extensions' is required to reach digest() / encode() from pgcrypto.
--   - is_site_admin(auth.uid()) check in every function body: even if a future
--     GRANT accidentally widens EXECUTE permissions, the function still rejects
--     non-admin callers at the SQL layer (defense-in-depth, OWASP A01:2021).
--   - Zero dynamic SQL: no EXECUTE, no format(), no dblink. Every SQL statement
--     is static so the function body is auditor-readable (SOC2 CC7.2 non-repudiation).
--   - Mutation + audit INSERT in the same function call = same implicit transaction.
--     If the audit INSERT fails the mutation rolls back and vice versa (threat-model
--     item: "audit log orphaning").
--
-- SOC2 CC7.2: Logical access control enforced at the database layer; every
--   mutation is audited in the same transaction as the mutation itself.
-- SOC2 CC6.1: Principle of least privilege — REVOKE ALL then targeted GRANT.
-- OWASP A01:2021 (Broken Access Control): Deny-by-default; is_site_admin() check
--   inside every function body as a second control layer beyond GRANT.
-- ============================================================================


-- ============================================================================
-- §3.5.1  admin_override_tier — Change a user's subscription tier manually
-- ============================================================================

/**
 * admin_override_tier
 *
 * Overrides a user's subscription tier and writes an audit log row. The
 * override sets override_source = 'manual', which causes the Polar webhook
 * handler to skip any conflicting replay until the override expires.
 *
 * Mutation and audit INSERT run in the same implicit transaction — if either
 * step fails the entire operation rolls back (no orphaned mutations, no silent
 * audit gaps).
 *
 * @param p_target_user_id  UUID of the user whose tier is being overridden
 * @param p_new_tier        New tier value — must be one of:
 *                          'free' | 'pro' | 'power' | 'team' | 'business' | 'enterprise'
 * @param p_expires_at      When the manual override expires (NULL = permanent).
 *                          After this timestamp the Polar webhook handler will
 *                          clear override_source back to 'polar'.
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP address captured by the route handler
 * @param p_ua              Admin's user-agent string captured by the route handler
 * @returns                 bigint id of the newly inserted admin_audit_log row
 *
 * @throws 42501            If the caller is not a site admin
 * @throws 22023            If p_new_tier is not in the allowed set
 * @throws 23514            If p_reason is NULL or empty
 *
 * Security model:
 *   - Caller must be authenticated (GRANT EXECUTE TO authenticated).
 *   - is_site_admin(auth.uid()) checked inside function body (defense-in-depth).
 *   - SECURITY DEFINER: runs with definer's schema privileges so it can UPDATE
 *     public.subscriptions and INSERT into public.admin_audit_log without
 *     granting those mutations to the 'authenticated' role.
 *
 * SOC2 CC7.2: Every tier change is recorded in admin_audit_log with before/after
 *   state, enabling complete reconstruction of subscription history for auditors.
 * SOC2 CC6.1: The function enforces least-privilege — only site admins may call it.
 */
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
-- WHY extensions in search_path: admin_audit_chain_hash trigger calls digest() +
-- encode() from pgcrypto, which Supabase installs in the 'extensions' schema.
-- Without this, the trigger fires correctly (it has its own search_path) but
-- our is_site_admin() call, which itself is SECURITY DEFINER with search_path =
-- public, pg_temp, will look for site_admins in the correct schema. Including
-- 'extensions' here is belt-and-suspenders for any future pgcrypto call we add.
-- pg_temp is always last to block search-path injection via temporary objects.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_before   jsonb;
  v_after    jsonb;
  v_audit_id bigint;
BEGIN
  -- Authorization: must be a site admin.
  -- WHY ERRCODE 42501 (insufficient_privilege): standard SQL error code for
  -- "permission denied". Lets callers programmatically distinguish auth errors
  -- from validation errors (22023, 23514) without parsing the message string.
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Validate tier value against the exhaustive allowed set.
  -- WHY: tier is text (not an enum) so it can be extended without a schema
  -- migration, but we still enforce the set here to prevent accidental data entry
  -- (e.g. 'Power' instead of 'power') from creating an unrecognized tier.
  -- WHY ERRCODE 22023 (invalid_parameter_value): signals a caller error, not a
  -- permissions error — the caller supplied an out-of-range value.
  IF p_new_tier NOT IN ('free', 'pro', 'power', 'team', 'business', 'enterprise') THEN
    -- WHY: Do not interpolate p_new_tier into the message — even non-PII caller-supplied
    -- strings create unnecessary data surface in error logs and exception propagation paths.
    -- Use a static message; callers get the ERRCODE 22023 for programmatic handling.
    RAISE EXCEPTION 'invalid tier value' USING ERRCODE = '22023';
  END IF;

  -- Reason is mandatory — DB CHECK constraint on admin_audit_log enforces it
  -- at the INSERT level, but we check here for a cleaner ERRCODE (23514 =
  -- check_violation, consistent with the DB constraint code).
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- Capture before-state for the audit diff.
  -- WHY to_jsonb(s.*): serializes the full row including new override columns so
  -- the audit log contains a complete snapshot, not just the fields we change.
  -- NULL v_before is acceptable if no subscriptions row exists yet (new user).
  SELECT to_jsonb(s.*) INTO v_before
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  -- Apply the override. Use UPDATE first; if the user has no subscriptions row
  -- yet, fall back to INSERT. Both paths set override_source = 'manual'.
  UPDATE public.subscriptions
    SET tier               = p_new_tier,
        override_source    = 'manual',
        override_expires_at = p_expires_at,
        override_reason    = p_reason,
        updated_at         = now()
    WHERE user_id = p_target_user_id;

  IF NOT FOUND THEN
    -- WHY: Some users (especially during onboarding) may not yet have a
    -- subscriptions row if they haven't completed billing setup. We INSERT
    -- a row so the override takes effect immediately regardless.
    INSERT INTO public.subscriptions (user_id, tier, override_source, override_expires_at, override_reason)
      VALUES (p_target_user_id, p_new_tier, 'manual', p_expires_at, p_reason);
  END IF;

  -- Capture after-state for the audit diff.
  SELECT to_jsonb(s.*) INTO v_after
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  -- Write the audit log row. The BEFORE INSERT trigger (admin_audit_chain_hash)
  -- computes prev_hash and row_hash — we do not supply them here.
  -- WHY: mutation + audit in the same statement block = same transaction.
  -- If the INSERT below fails (e.g. FK violation) the UPDATE/INSERT above also
  -- rolls back, so there are never mutations without an audit record.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason, ip, user_agent)
  VALUES
    (v_actor, p_target_user_id, 'override_tier', 'subscriptions', v_before, v_after, p_reason, p_ip, p_ua)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

-- WHY: REVOKE ALL from PUBLIC first, then grant only to 'authenticated'.
-- This follows the principle of least privilege (SOC2 CC6.1). 'anon' is
-- excluded because admin operations must require an authenticated session.
REVOKE ALL ON FUNCTION public.admin_override_tier(uuid, text, timestamptz, text, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_override_tier(uuid, text, timestamptz, text, inet, text) TO authenticated;


-- ============================================================================
-- §3.5.2  admin_toggle_consent — Grant or revoke a per-user consent flag
-- ============================================================================

/**
 * admin_toggle_consent
 *
 * Grants or revokes a per-user consent flag of a given purpose. Upserts the
 * consent_flags row (ON CONFLICT ... DO UPDATE) to handle both the initial grant
 * and subsequent re-grant/revoke operations on the same (user_id, purpose) pair.
 *
 * Mutation and audit INSERT run in the same implicit transaction.
 *
 * @param p_target_user_id  UUID of the user whose consent is being toggled
 * @param p_purpose         The consent_purpose enum value to grant or revoke
 * @param p_grant           true = grant consent; false = revoke consent
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP address captured by the route handler
 * @param p_ua              Admin's user-agent string captured by the route handler
 * @returns                 bigint id of the newly inserted admin_audit_log row
 *
 * @throws 42501            If the caller is not a site admin
 * @throws 23514            If p_reason is NULL or empty
 *
 * Security model:
 *   - Caller must be authenticated (GRANT EXECUTE TO authenticated).
 *   - is_site_admin(auth.uid()) enforced inside function body.
 *   - SECURITY DEFINER: runs with definer's schema privileges to INSERT/UPDATE
 *     consent_flags without granting direct table mutations to 'authenticated'.
 *   - No direct INSERT/UPDATE policy exists on consent_flags for 'authenticated' —
 *     this function is the only app-layer mutation path.
 *
 * SOC2 CC7.2: Every consent change is captured in admin_audit_log with full
 *   before/after state for auditor review.
 * SOC2 CC6.1: Least-privilege enforced via REVOKE ALL + targeted GRANT.
 * GDPR Article 7: Consent records must be maintained and revocable — this
 *   function implements the revocation path.
 */
CREATE OR REPLACE FUNCTION public.admin_toggle_consent(
  p_target_user_id  uuid,
  p_purpose         public.consent_purpose,
  p_grant           boolean,
  p_reason          text,
  p_ip              inet,
  p_ua              text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as admin_override_tier —
-- pgcrypto functions live in 'extensions' on Supabase. pg_temp last.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_before   jsonb;
  v_after    jsonb;
  v_audit_id bigint;
BEGIN
  -- Authorization: must be a site admin.
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Reason is mandatory.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- Capture before-state. NULL if no row exists yet for this (user, purpose).
  SELECT to_jsonb(cf.*) INTO v_before
    FROM public.consent_flags cf
    WHERE cf.user_id = p_target_user_id
      AND cf.purpose = p_purpose;

  IF p_grant THEN
    -- Grant: upsert with ON CONFLICT (creates row on first grant, re-grants a revoked row).
    -- WHY ON CONFLICT DO UPDATE rather than separate INSERT/UPDATE branches:
    -- single-statement upsert is atomic and avoids a race condition where two
    -- concurrent grant calls for the same (user_id, purpose) could produce two rows
    -- (which the UNIQUE constraint would catch, but with a less clear error).
    INSERT INTO public.consent_flags
      (user_id, purpose, granted_at, revoked_at, granted_by, note)
    VALUES
      (p_target_user_id, p_purpose, now(), NULL, v_actor, p_reason)
    ON CONFLICT (user_id, purpose) DO UPDATE SET
      granted_at = now(),
      revoked_at = NULL,
      granted_by = v_actor,
      note       = p_reason;
  ELSE
    -- Revoke: only UPDATE if a consent row already exists; otherwise this is a no-op
    -- mutation (audit row is still written, but no consent_flags row is inserted).
    -- WHY: inserting a ghost row with granted_at = NULL, revoked_at = <timestamp>
    -- is semantically meaningless — there was never a grant to revoke. Phase 4.2
    -- UI queries treat any consent_flags row as evidence of a past consent event;
    -- a ghost row would misrepresent the user's history. The audit trail records
    -- "admin attempted to revoke consent for user X but they had no active consent"
    -- which is accurate and fully auditable without creating corrupted state.
    -- WHY direct UPDATE (not ON CONFLICT): the row already exists if v_before IS NOT NULL,
    -- so no INSERT is needed; UPDATE preserves granted_at (documents original grant time)
    -- and granted_by (documents original granter) for the full lifecycle audit trail.
    IF v_before IS NOT NULL THEN
      UPDATE public.consent_flags
        SET revoked_at = now(),
            note       = p_reason
        WHERE user_id = p_target_user_id
          AND purpose  = p_purpose;
    END IF;
  END IF;

  -- Capture after-state.
  SELECT to_jsonb(cf.*) INTO v_after
    FROM public.consent_flags cf
    WHERE cf.user_id = p_target_user_id
      AND cf.purpose = p_purpose;

  -- Write audit log — same transaction as upsert above.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason, ip, user_agent)
  VALUES
    (v_actor, p_target_user_id, 'toggle_consent', 'consent_flags', v_before, v_after, p_reason, p_ip, p_ua)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_toggle_consent(uuid, public.consent_purpose, boolean, text, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_toggle_consent(uuid, public.consent_purpose, boolean, text, inet, text) TO authenticated;


-- ============================================================================
-- §3.5.3  admin_record_password_reset — Audit-only wrapper for password resets
-- ============================================================================

/**
 * admin_record_password_reset
 *
 * Writes an admin audit log row for a password reset operation. This function
 * does NOT send the magic link — that happens in the Node.js route handler via
 * supabase.auth.admin.generateLink() AFTER this function returns successfully.
 *
 * The split design means the audit record is written BEFORE the magic link is
 * sent. If the magic link send fails the audit row persists (the admin's intent
 * to reset the password is still an auditable event). If this function fails the
 * route handler will not proceed to send the magic link, so no password reset
 * occurs without a corresponding audit row.
 *
 * before_json captures a minimal snapshot of the auth.users row (id, email,
 * created_at, last_sign_in_at only — no password hashes or sensitive columns).
 * after_json is NULL because this function does not mutate auth.users.
 *
 * @param p_target_user_id  UUID of the user whose password is being reset
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP address captured by the route handler
 * @param p_ua              Admin's user-agent string captured by the route handler
 * @returns                 bigint id of the newly inserted admin_audit_log row
 *
 * @throws 42501            If the caller is not a site admin
 * @throws 23514            If p_reason is NULL or empty
 *
 * Security model:
 *   - Caller must be authenticated (GRANT EXECUTE TO authenticated).
 *   - is_site_admin(auth.uid()) enforced inside function body.
 *   - SECURITY DEFINER: runs with definer's schema privileges to SELECT from
 *     auth.users (which is restricted to service_role by default in Supabase)
 *     and INSERT into admin_audit_log.
 *   - Only non-sensitive auth.users columns are captured in before_json.
 *     Specifically, encrypted_password and other sensitive auth internals are
 *     NOT included — only columns needed for auditor identification.
 *
 * SOC2 CC7.2: Password reset events are logged before the reset is executed,
 *   ensuring the audit trail is complete even if the reset delivery fails.
 * SOC2 CC6.1: Function callable only by authenticated site admins.
 * OWASP A09:2021 (Security Logging and Monitoring Failures): Admin password
 *   reset is a high-risk event that must always be logged.
 */
CREATE OR REPLACE FUNCTION public.admin_record_password_reset(
  p_target_user_id  uuid,
  p_reason          text,
  p_ip              inet,
  p_ua              text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as admin_override_tier.
-- Additionally, SECURITY DEFINER is required here to SELECT from auth.users,
-- which Supabase grants only to service_role and postgres by default.
-- Without SECURITY DEFINER this SELECT would fail for 'authenticated' callers.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_before   jsonb;
  v_audit_id bigint;
BEGIN
  -- Authorization: must be a site admin.
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Reason is mandatory.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- Capture a minimal snapshot of the auth.users row for the audit record.
  -- WHY only 4 columns: We need enough to identify the user in the audit UI
  -- (id, email) and provide operational context (created_at, last_sign_in_at).
  -- We deliberately exclude encrypted_password, raw_user_meta_data, and other
  -- internal Supabase columns that have no audit value and create unnecessary
  -- data exposure in the audit log.
  -- WHY jsonb_build_object rather than to_jsonb(u.*): prevents accidentally
  -- capturing sensitive auth columns if Supabase adds new columns to auth.users
  -- in a future version — we enumerate the exact columns we want.
  SELECT jsonb_build_object(
           'id',              u.id,
           'email',           u.email,
           'created_at',      u.created_at,
           'last_sign_in_at', u.last_sign_in_at
         )
    INTO v_before
    FROM auth.users u
    WHERE u.id = p_target_user_id;

  -- Write the audit row. after_json is intentionally NULL — this function does
  -- not mutate auth.users. The actual password reset (magic link generation)
  -- happens in the Node.js route handler after this function returns.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason, ip, user_agent)
  VALUES
    (v_actor, p_target_user_id, 'reset_password', 'auth.users', v_before, NULL, p_reason, p_ip, p_ua)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_record_password_reset(uuid, text, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_record_password_reset(uuid, text, inet, text) TO authenticated;

-- ============================================================================
-- Migration 041 complete.
-- ============================================================================
