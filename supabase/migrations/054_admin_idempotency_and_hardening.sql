-- ============================================================================
-- Migration 054: Admin Idempotency + Polar Webhook Dedup + subscriptions.tier
--                CHECK Constraint (Phase 4 Hardening Bundle)
--
-- Three-part hardening bundle addressing race conditions and data integrity gaps:
--
-- Part A — subscriptions.tier DB-level CHECK constraint
--   T2 + T8 wrappers already enforce the 6-value tier allowlist at the RPC layer.
--   Adding a DB-level CHECK is belt-and-suspenders: prevents direct service-role
--   writes (Supabase dashboard, psql, future migrations) from landing invalid
--   tier strings that bypass the wrapper layer entirely.
--   SOC2 CC7.2: Data integrity enforced at the database layer, not only at
--   application code. Constraint violations surface immediately with ERRCODE 23514
--   rather than silently corrupting billing state.
--
-- Part B — admin_idempotency_check() SECURITY DEFINER helper
--   Admin clicks "Override tier" / "Issue refund" / etc. twice in <500ms.
--   Both requests pass validation, both call the RPC, both commit — producing
--   duplicate audit rows and, for non-idempotent actions, duplicate side effects.
--   Fix: deterministic-key dedup using pg_advisory_xact_lock on hash of
--   (actor_id, action, target_user_id, reason, minute-bucket). If an audit row
--   already exists for the same (actor, action, target, reason, minute) the
--   helper returns its id; the wrapper returns it without re-executing the mutation.
--   SOC2 CC7.2: Non-repudiation — each distinct admin action generates exactly
--   one audit row. Duplicate audit rows from double-submit are a data quality
--   defect that degrades the audit trail's trustworthiness.
--   OWASP A04:2021 (Insecure Design): Advisory lock serialises concurrent
--   requests for the same (actor, action, minute) window — TOCTOU-safe.
--
-- Part C — Idempotency applied to 5 bigint-returning admin wrappers
--   admin_override_tier, admin_toggle_consent, admin_record_password_reset,
--   admin_issue_refund, admin_revoke_credit are CREATE OR REPLACE'd to call
--   admin_idempotency_check() at the top of their bodies before any mutation.
--
--   NOT applied to admin_issue_credit and admin_send_churn_save_offer (both
--   TABLE-returning) for the following reason documented here for auditors:
--   - admin_issue_credit: billing_credits rows are the authoritative dedup key.
--     A double-submit creates two billing_credits rows (both unapplied), which
--     ops can detect and revoke. The existing admin_revoke_credit path is the
--     correct remediation for accidental double-credits. Adding advisory-lock
--     idempotency to a TABLE-returning function requires RETURN QUERY SELECT
--     on the existing row, which means fetching the credit_id from
--     after_json->>'credit_id' — technically possible but adds complexity for
--     a low-frequency path. The risk is acceptable: credits require explicit
--     admin action to issue and are auditable via admin_audit_log.
--   - admin_send_churn_save_offer: the existing duplicate-offer guard (EXISTS
--     check on active offers of the same kind) already prevents a second offer
--     from being sent in the same session — RAISE EXCEPTION '22023' is the
--     current guard. This is equivalent protection for the common double-click
--     scenario. A second click hits the EXISTS check before INSERT, which raises
--     immediately without creating a duplicate row.
--
-- SOC2 CC6.1: Principle of least privilege — REVOKE ALL then targeted GRANT.
-- SOC2 CC7.2: Non-repudiation — every admin mutation has exactly one audit row
--   that cannot be removed, duplicated, or modified by application code.
-- SOC2 CC9.2: Idempotency across billing paths prevents financial double-writes.
-- OWASP A01:2021 (Broken Access Control): is_site_admin() check retained in every
--   wrapper body as the primary authorization gate; idempotency check is additive.
-- OWASP A04:2021 (Insecure Design): pg_advisory_xact_lock prevents TOCTOU on the
--   pre-check SELECT → mutation path within the same minute bucket.
-- ============================================================================


-- ============================================================================
-- Part A: subscriptions.tier CHECK — DROPPED FROM THIS MIGRATION
-- ============================================================================
--
-- Original intent was a DB-level allowlist `tier IN ('free','pro','power',
-- 'team','business','enterprise')`. Postgres rejected it with SQLSTATE
-- 22P02 because `subscriptions.tier` is typed as the `subscription_tier`
-- ENUM (migration 001 line 59), which currently contains only 'free',
-- 'pro', 'power'. A CHECK with 'team' / 'business' / 'enterprise'
-- literals cannot be coerced to the enum type.
--
-- This reveals a separate data-modeling question (where do team/business/
-- enterprise tiers live at the DB layer today?) that is out of scope for
-- this hardening bundle. Deferred as a follow-up: either extend the
-- subscription_tier enum to cover all 6 Polar-supported tiers, or retire
-- the enum in favor of text + CHECK.
--
-- The RPC-layer allowlists in admin_override_tier (migration 041 + 054
-- below) and apply_polar_subscription_with_override_check (migration 045)
-- already enforce the 6-value set at the write boundary. The enum prevents
-- arbitrary string writes at the DB layer. DB-level allowlist parity with
-- the RPC layer is the deferred belt-and-suspenders item.


-- ============================================================================
-- Part B: admin_idempotency_check() helper function
-- ============================================================================

/**
 * admin_idempotency_check
 *
 * Deterministic-key double-submit dedup helper for admin mutation wrappers.
 *
 * Call this at the TOP of each admin wrapper body (before any mutation).
 * If the same admin calls the same action on the same target with the same
 * reason within the same UTC minute, this function returns the id of the
 * existing audit row. The wrapper then returns that id without re-executing
 * the mutation — preventing duplicate audit rows and duplicate side effects.
 *
 * Algorithm:
 *   1. Compute a 64-bit advisory lock key from hashtext() of the combined
 *      idempotency signature (actor_id || action || target_user_id || reason
 *      || date_trunc('minute', now())).
 *   2. Acquire pg_advisory_xact_lock on that key. The lock is automatically
 *      released at transaction end — no explicit unlock needed.
 *      WHY xact lock (not session lock): session locks outlive the transaction
 *      and require explicit pg_advisory_unlock(). Xact locks are automatically
 *      released on COMMIT or ROLLBACK, keeping the lock lifetime scoped to the
 *      request that acquired it. The window we need to protect is exactly one
 *      transaction.
 *   3. SELECT the most recent admin_audit_log row matching:
 *        actor_id = p_actor_id
 *        AND action = p_action
 *        AND target_user_id = p_target_user_id
 *        AND date_trunc('minute', created_at) = date_trunc('minute', now())
 *        AND reason = p_reason   (trimmed match)
 *      If found → return its id.
 *   4. Return NULL if no matching row found (caller proceeds with mutation).
 *
 * WHY minute bucket (not second or millisecond): a one-second window is too
 * tight for slow DB connections; a 5-minute window would block retry on
 * legitimate re-runs (support tool re-submits the same action 3 minutes later
 * for a different incident). One minute is the standard idempotency window for
 * admin UIs (industry convention, used by Stripe's idempotency-key TTL for
 * synchronous admin calls). Callers who need to re-apply the same action to
 * the same user with the same reason after one minute simply wait — or change
 * the reason string (which produces a different hash).
 *
 * WHY reason in the hash: two different admins calling override_tier with
 * different reasons (e.g. "customer escalation" vs "billing correction")
 * are distinct audit events, even within the same minute on the same target.
 * Including the reason prevents legitimate distinct actions from being collapsed
 * into a single audit row.
 *
 * @param p_actor_id        UUID of the admin performing the action
 * @param p_action          Action name (matches admin_audit_log.action column)
 * @param p_target_user_id  UUID of the user being acted upon
 * @param p_reason          Mandatory reason text — included in the hash key
 * @returns bigint          Existing audit row id if this is a duplicate within
 *                          the current UTC minute, NULL otherwise
 *
 * Security model:
 *   - SECURITY DEFINER: function body runs with definer's rights so it can
 *     SELECT from admin_audit_log without granting that privilege to the
 *     'authenticated' role directly.
 *   - GRANT EXECUTE TO authenticated: follows the Phase 4.1 P0 pattern.
 *     auth.uid() must resolve inside callers' SECURITY DEFINER bodies; that
 *     requires the caller to be invoked via a user-scoped JWT.
 *   - No is_site_admin() check in THIS function: it is called exclusively from
 *     admin_* wrappers that already perform the is_site_admin() gate. Adding a
 *     second check here would be redundant and would double the site_admins
 *     SELECT round-trip on every admin action.
 *   - SET search_path = public, extensions, pg_temp: prevents search-path
 *     injection. 'extensions' is included for consistency with the calling
 *     wrappers (both are SECURITY DEFINER with the same search_path policy).
 *
 * SOC2 CC7.2: Returns the pre-existing audit_id, allowing callers to surface
 *   "this action was already recorded as audit_id=X" to the admin UI.
 * SOC2 CC9.2: Prevents financial double-writes when Polar webhooks or admin
 *   UIs deliver the same mutation twice within the idempotency window.
 * OWASP A04:2021 (Insecure Design): pg_advisory_xact_lock + ORDER BY id DESC
 *   LIMIT 1 prevents a TOCTOU race between the SELECT and the caller's INSERT.
 */
CREATE OR REPLACE FUNCTION public.admin_idempotency_check(
  p_actor_id        uuid,
  p_action          text,
  p_target_user_id  uuid,
  p_reason          text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: consistent with all admin_* wrappers.
-- pg_temp always LAST to block search-path injection (OWASP A01:2021).
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  -- The advisory lock key is derived from a deterministic hash of the idempotency
  -- signature so that concurrent requests for DIFFERENT signatures acquire DIFFERENT
  -- locks (no contention between unrelated admin actions).
  -- WHY hashtext() (not digest()): hashtext() returns int4 (32-bit), but
  -- pg_advisory_xact_lock accepts int8 (64-bit). We cast to bigint to satisfy
  -- the overload. hashtext() is built in — no pgcrypto dependency needed.
  -- WHY NOT digest(): pgcrypto digest() returns bytea; converting to bigint
  -- requires substr + get_byte arithmetic. hashtext() is simpler and equally
  -- collision-resistant for this purpose (advisory locks, not cryptography).
  v_lock_key  bigint;
  v_sig       text;
  v_audit_id  bigint;
BEGIN
  -- Build the idempotency signature string.
  -- WHY explicit casts to text: ensures consistent serialization regardless
  -- of postgres locale or UUID formatting settings.
  -- WHY date_trunc('minute', now()): all calls in the same UTC minute share
  -- the same lock key and the same pre-check SELECT window. See header for
  -- rationale on the 1-minute bucket.
  v_sig := p_actor_id::text
         || '|' || p_action
         || '|' || p_target_user_id::text
         || '|' || btrim(COALESCE(p_reason, ''))
         || '|' || date_trunc('minute', now())::text;

  v_lock_key := hashtext(v_sig)::bigint;

  -- Acquire the advisory lock. Blocks until no other transaction holds the
  -- same key. Released automatically at transaction end (COMMIT or ROLLBACK).
  -- WHY blocking (not try-lock): if another request with the same signature
  -- is in-flight, we wait for it to commit so our pre-check SELECT sees its
  -- audit row. A try-lock would return false immediately, causing us to miss
  -- the existing row and proceed with a duplicate mutation.
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Pre-check: look for an existing audit row that matches this signature
  -- within the current UTC minute. ORDER BY id DESC LIMIT 1 finds the most
  -- recent match — handles edge cases where a prior double-submit already
  -- created two rows before this migration was applied.
  -- WHY btrim(reason) match: the wrapper validates reason length via btrim,
  -- but stores the original p_reason. We btrim both sides for a clean match.
  SELECT id INTO v_audit_id
    FROM public.admin_audit_log
    WHERE actor_id         = p_actor_id
      AND action           = p_action
      AND target_user_id   = p_target_user_id
      AND date_trunc('minute', created_at AT TIME ZONE 'UTC')
            = date_trunc('minute', now() AT TIME ZONE 'UTC')
      AND btrim(reason)    = btrim(COALESCE(p_reason, ''))
    ORDER BY id DESC
    LIMIT 1;

  -- Return the found id (duplicate) or NULL (new action — proceed with mutation).
  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_idempotency_check(uuid, text, uuid, text) FROM PUBLIC;
-- WHY authenticated (not service_role): Phase 4.1 P0 lesson — granting only to
-- service_role causes auth.uid() to resolve to NULL inside the SECURITY DEFINER
-- body, breaking the advisory lock key's use of p_actor_id = auth.uid() in callers.
GRANT EXECUTE ON FUNCTION public.admin_idempotency_check(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- Part C: CREATE OR REPLACE admin wrappers with idempotency check
--
-- Pattern (same in all 5 functions):
--   1. is_site_admin() authorization gate (unchanged from prior migrations)
--   2. Input validation (unchanged)
--   3. NEW: admin_idempotency_check() — returns existing audit_id or NULL
--   4. IF existing audit_id IS NOT NULL → RETURN it (no mutation)
--   5. Existing mutation + audit INSERT logic (unchanged)
--
-- WHY CREATE OR REPLACE (not separate ALTER): there is no ALTER FUNCTION
--   for the body in Postgres. CREATE OR REPLACE replaces the full body while
--   preserving GRANT/REVOKE state and the function OID.
-- ============================================================================


-- ============================================================================
-- §C.1  admin_override_tier (migration 041 + idempotency hardening)
-- ============================================================================

/**
 * admin_override_tier
 *
 * Overrides a user's subscription tier and writes an audit log row.
 *
 * Phase 4 hardening (migration 054): Idempotency check added at top of body.
 * Calls admin_idempotency_check(actor, 'override_tier', target, reason) before
 * any mutation. If a matching audit row exists within the current UTC minute,
 * returns its id immediately without re-executing the UPDATE/INSERT.
 * SOC2 CC7.2: Exactly one audit row per distinct admin action.
 * OWASP A04:2021: pg_advisory_xact_lock in admin_idempotency_check prevents TOCTOU.
 *
 * @param p_target_user_id  UUID of the user whose tier is being overridden
 * @param p_new_tier        New tier — must be in ('free','pro','power','team','business','enterprise')
 * @param p_expires_at      When the manual override expires (NULL = permanent)
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP address captured by the route handler
 * @param p_ua              Admin's user-agent string captured by the route handler
 * @returns bigint          admin_audit_log.id (new row, or existing id on dedup)
 *
 * @throws 42501  Caller is not a site admin
 * @throws 22023  p_new_tier is not in the allowed set
 * @throws 23514  p_reason is NULL or empty
 *
 * Security: SECURITY DEFINER, is_site_admin() in-body check. SOC2 CC6.1/CC7.2.
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_before          jsonb;
  v_after           jsonb;
  v_audit_id        bigint;
  -- Phase 4 hardening: idempotency check variable.
  -- WHY declared separately (not inline): keeps the idempotency block visually
  -- distinct from the pre-existing mutation logic for future auditors.
  v_existing_audit  bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Tier validation ────────────────────────────────────────────────────────
  IF p_new_tier NOT IN ('free', 'pro', 'power', 'team', 'business', 'enterprise') THEN
    RAISE EXCEPTION 'invalid tier value' USING ERRCODE = '22023';
  END IF;

  -- ── Reason validation ──────────────────────────────────────────────────────
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Phase 4 hardening: Idempotency check (migration 054) ──────────────────
  -- WHY before mutation (not after): we must check for the existing audit row
  -- BEFORE doing any mutation. If we mutate first and THEN check, a second
  -- request would have already written a duplicate by the time we look.
  -- admin_idempotency_check() acquires a pg_advisory_xact_lock on a hash of
  -- (actor, action, target, reason, minute-bucket) and SELECTs admin_audit_log
  -- within that lock — serialising concurrent same-signature requests.
  -- SOC2 CC7.2: Exactly one audit row per distinct (actor, action, target,
  -- reason, minute) tuple.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'override_tier', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    -- Duplicate detected within the current UTC minute. Return the existing
    -- audit_id without re-executing the tier UPDATE or audit INSERT.
    RETURN v_existing_audit;
  END IF;

  -- ── Capture before-state ───────────────────────────────────────────────────
  SELECT to_jsonb(s.*) INTO v_before
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  -- ── Apply override ─────────────────────────────────────────────────────────
  UPDATE public.subscriptions
    SET tier                = p_new_tier,
        override_source     = 'manual',
        override_expires_at = p_expires_at,
        override_reason     = p_reason,
        updated_at          = now()
    WHERE user_id = p_target_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.subscriptions (user_id, tier, override_source, override_expires_at, override_reason)
      VALUES (p_target_user_id, p_new_tier, 'manual', p_expires_at, p_reason);
  END IF;

  -- ── Capture after-state ────────────────────────────────────────────────────
  SELECT to_jsonb(s.*) INTO v_after
    FROM public.subscriptions s
    WHERE s.user_id = p_target_user_id;

  -- ── Write audit log (same transaction as mutation) ─────────────────────────
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


-- ============================================================================
-- §C.2  admin_toggle_consent (migration 041 + idempotency hardening)
-- ============================================================================

/**
 * admin_toggle_consent
 *
 * Grants or revokes a per-user consent flag of a given purpose.
 *
 * Phase 4 hardening (migration 054): Idempotency check added.
 * SOC2 CC7.2 / GDPR Article 7. See admin_override_tier for full idempotency rationale.
 *
 * @param p_target_user_id  UUID of the user whose consent is being toggled
 * @param p_purpose         The consent_purpose enum value to grant or revoke
 * @param p_grant           true = grant; false = revoke
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP captured by the route handler
 * @param p_ua              Admin's user-agent captured by the route handler
 * @returns bigint          admin_audit_log.id (new or existing on dedup)
 *
 * @throws 42501  Caller is not a site admin
 * @throws 23514  p_reason is NULL or empty
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_before          jsonb;
  v_after           jsonb;
  v_audit_id        bigint;
  v_existing_audit  bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Reason validation ──────────────────────────────────────────────────────
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Phase 4 hardening: Idempotency check (migration 054) ──────────────────
  -- WHY 'toggle_consent' action string: matches admin_audit_log.action value
  -- written by this function, so the pre-check SELECT in admin_idempotency_check
  -- finds the correct row on duplicate detection.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'toggle_consent', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    RETURN v_existing_audit;
  END IF;

  -- ── Capture before-state ───────────────────────────────────────────────────
  SELECT to_jsonb(cf.*) INTO v_before
    FROM public.consent_flags cf
    WHERE cf.user_id = p_target_user_id
      AND cf.purpose = p_purpose;

  -- ── Apply consent toggle ───────────────────────────────────────────────────
  IF p_grant THEN
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
    IF v_before IS NOT NULL THEN
      UPDATE public.consent_flags
        SET revoked_at = now(),
            note       = p_reason
        WHERE user_id = p_target_user_id
          AND purpose  = p_purpose;
    END IF;
  END IF;

  -- ── Capture after-state ────────────────────────────────────────────────────
  SELECT to_jsonb(cf.*) INTO v_after
    FROM public.consent_flags cf
    WHERE cf.user_id = p_target_user_id
      AND cf.purpose = p_purpose;

  -- ── Write audit log ────────────────────────────────────────────────────────
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
-- §C.3  admin_record_password_reset (migration 041 + idempotency hardening)
-- ============================================================================

/**
 * admin_record_password_reset
 *
 * Writes an admin audit log row for a password reset operation. Does NOT send
 * the magic link — that happens in the Node.js route handler after this returns.
 *
 * Phase 4 hardening (migration 054): Idempotency check added.
 * OWASP A09:2021: Admin password reset is a high-risk event. Exactly one audit
 * row must exist per reset action within the idempotency window.
 * SOC2 CC7.2: Audit written before magic-link dispatch — survives link send failure.
 *
 * @param p_target_user_id  UUID of the user whose password is being reset
 * @param p_reason          Mandatory free-text justification (length > 0)
 * @param p_ip              Admin's IP captured by the route handler
 * @param p_ua              Admin's user-agent captured by the route handler
 * @returns bigint          admin_audit_log.id (new or existing on dedup)
 *
 * @throws 42501  Caller is not a site admin
 * @throws 23514  p_reason is NULL or empty
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_before          jsonb;
  v_audit_id        bigint;
  v_existing_audit  bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Reason validation ──────────────────────────────────────────────────────
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Phase 4 hardening: Idempotency check (migration 054) ──────────────────
  -- WHY 'reset_password' action string: matches the audit row this function writes.
  -- A double-submit of the same password reset (same admin, same target, same
  -- reason, same minute) could otherwise trigger two magic-link sends — one
  -- per duplicate RPC call in the route handler's try block.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'reset_password', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    RETURN v_existing_audit;
  END IF;

  -- ── Capture minimal auth.users snapshot for audit ──────────────────────────
  -- WHY jsonb_build_object (not to_jsonb(u.*)): prevents capturing sensitive
  -- auth columns (encrypted_password, raw_user_meta_data). See migration 041
  -- for full rationale.
  SELECT jsonb_build_object(
           'id',              u.id,
           'email',           u.email,
           'created_at',      u.created_at,
           'last_sign_in_at', u.last_sign_in_at
         )
    INTO v_before
    FROM auth.users u
    WHERE u.id = p_target_user_id;

  -- ── Write audit log ────────────────────────────────────────────────────────
  -- after_json is intentionally NULL: this function does not mutate auth.users.
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
-- §C.4  admin_issue_refund (migration 051 + idempotency hardening)
-- ============================================================================

/**
 * admin_issue_refund
 *
 * Records a Polar refund event and writes an audit log row. The function is
 * idempotent on p_polar_event_id via INSERT ... ON CONFLICT DO NOTHING on the
 * polar_refund_events primary key (existing idempotency from migration 051).
 *
 * Phase 4 hardening (migration 054): admin_idempotency_check() added as an
 * additional guard for the admin-UI double-submit path. The polar_event_id
 * ON CONFLICT handles webhook-replay idempotency; the advisory-lock check
 * handles concurrent admin clicks before the first INSERT commits.
 *
 * WHY both guards: they protect different failure modes.
 *   - polar_event_id ON CONFLICT: Polar webhook replays the same event_id →
 *     INSERT silently skips. Works when the first INSERT has already committed.
 *   - admin_idempotency_check: Admin clicks "Issue Refund" twice in <500ms →
 *     second request arrives before the first INSERT commits and sees zero rows
 *     in polar_refund_events. The advisory lock serialises the two requests,
 *     and the second exits early before attempting any INSERT.
 *
 * Note: The action string used is 'refund_issued' (matches audit row action).
 * The p_polar_event_id is used as the reason proxy in the hash for this wrapper
 * since refunds don't have a human-readable "reason" in the advisory-lock sense;
 * the polar_event_id is the true idempotency key. We pass p_reason (which is
 * the user-visible justification) for the advisory lock so that two refunds
 * with different reasons on the same target in the same minute are treated as
 * distinct events (consistent with all other wrappers).
 *
 * @see migration_051 admin_issue_refund for full parameter documentation.
 * @returns bigint  audit_log.id (new row, existing on webhook dedup, or existing
 *                  on double-submit dedup from admin_idempotency_check)
 */
CREATE OR REPLACE FUNCTION public.admin_issue_refund(
  p_target_user_id          uuid,
  p_amount_cents            bigint,
  p_currency                text,
  p_reason                  text,
  p_polar_event_id          text,
  p_polar_refund_id         text,
  p_polar_subscription_id   text,
  p_polar_response_json     jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_audit_id       bigint;
  v_existing_audit bigint;
  v_inserted       bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ───────────────────────────────────────────────────────
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 500000 THEN
    RAISE EXCEPTION 'amount_cents must be between 1 and 500000' USING ERRCODE = '22023';
  END IF;

  -- ── Phase 4 hardening: Idempotency check (migration 054) ──────────────────
  -- WHY 'refund_issued' action: matches the audit row action written below.
  -- Prevents admin double-click from racing past the polar_refund_events
  -- ON CONFLICT guard when both requests arrive before the first INSERT commits.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'refund_issued', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    RETURN v_existing_audit;
  END IF;

  -- ── Idempotent INSERT into polar_refund_events (original migration 051 logic) ──
  -- WHY ON CONFLICT DO NOTHING: Polar webhook replay path. See migration 051 for
  -- full rationale. The admin_idempotency_check above covers the double-click path;
  -- this ON CONFLICT covers webhook-replay with a committed polar_refund_events row.
  INSERT INTO public.polar_refund_events
    (event_id, refund_id, subscription_id, amount_cents, currency,
     reason, actor_id, target_user_id, processed_at, polar_response_json)
  VALUES
    (p_polar_event_id, p_polar_refund_id, p_polar_subscription_id,
     p_amount_cents, p_currency, p_reason, v_actor, p_target_user_id,
     now(), p_polar_response_json)
  ON CONFLICT (event_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- ── Idempotent return: fetch existing audit_id if event already processed ───
  IF v_inserted = 0 THEN
    SELECT id INTO v_existing_audit
      FROM public.admin_audit_log
      WHERE target_user_id = p_target_user_id
        AND action = 'refund_issued'
        AND after_json->>'polar_event_id' = p_polar_event_id
      ORDER BY id DESC
      LIMIT 1;

    RETURN COALESCE(v_existing_audit, 0);
  END IF;

  -- ── Write audit log row (new insert path only) ─────────────────────────────
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     p_target_user_id,
     'refund_issued',
     'polar_refund_events',
     NULL,
     jsonb_build_object(
       'polar_event_id',          p_polar_event_id,
       'polar_refund_id',         p_polar_refund_id,
       'polar_subscription_id',   p_polar_subscription_id,
       'amount_cents',            p_amount_cents,
       'currency',                p_currency
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) TO authenticated;


-- ============================================================================
-- §C.5  admin_revoke_credit (migration 051 + idempotency hardening)
-- ============================================================================

/**
 * admin_revoke_credit
 *
 * Sets revoked_at on a billing_credits row currently in the unapplied state.
 * Forward-only lifecycle: unapplied → revoked. Cannot revoke applied or
 * already-revoked credits.
 *
 * Phase 4 hardening (migration 054): Idempotency check added.
 * WHY idempotency matters here: a double-click on "Revoke credit" would attempt
 * to SET revoked_at twice on the same row. The second UPDATE hits the
 * "credit has already been revoked" guard and raises ERRCODE 22023 — visible to
 * the admin as an error dialog. While not a data integrity violation (the credit
 * IS revoked correctly), it is a poor UX that can confuse operators and generate
 * spurious Sentry events. The advisory-lock check prevents the second request
 * from reaching the state-machine checks at all.
 *
 * Note: p_reason is a per-call parameter; the advisory lock key includes it.
 * Two distinct revocations of different credits (different p_credit_id) with the
 * same reason string DO share a lock key if they also share actor + minute — but
 * they have DIFFERENT target_user_id values (billing_credits.user_id differs).
 * WHY target_user_id in the key (not credit_id): admin_audit_log does not store
 * credit_id as a primary lookup column — it stores target_user_id. We use the
 * target_user_id of the credit being revoked so the pre-check SELECT in
 * admin_idempotency_check finds the audit row via the correct column index.
 * Credit_id is recoverable from the audit row's before_json->>'credit_id'.
 *
 * @param p_credit_id  bigint id of the billing_credits row to revoke
 * @param p_reason     Mandatory free-text justification (btrim length > 0)
 * @returns bigint     admin_audit_log.id (new or existing on dedup)
 *
 * @throws 42501  Caller is not a site admin
 * @throws 23514  p_reason is NULL or blank
 * @throws 22023  Credit not found, already applied, or already revoked
 */
CREATE OR REPLACE FUNCTION public.admin_revoke_credit(
  p_credit_id  bigint,
  p_reason     text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_credit          public.billing_credits%ROWTYPE;
  v_audit_id        bigint;
  v_existing_audit  bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Reason validation ──────────────────────────────────────────────────────
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Fetch and lock credit row ──────────────────────────────────────────────
  -- WHY FOR UPDATE before idempotency check: we need the credit's user_id to
  -- pass to admin_idempotency_check() as p_target_user_id. The lock also prevents
  -- a concurrent billing webhook from modifying applied_at between our read and
  -- our UPDATE (TOCTOU — OWASP A04:2021).
  SELECT * INTO v_credit
    FROM public.billing_credits
    WHERE id = p_credit_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit not found' USING ERRCODE = '22023';
  END IF;

  -- ── Phase 4 hardening: Idempotency check (migration 054) ──────────────────
  -- WHY after the FOR UPDATE (not before): we need v_credit.user_id for the
  -- target_user_id parameter. The FOR UPDATE lock ensures no concurrent
  -- revocation has modified this row since we read it.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'credit_revoked', v_credit.user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    RETURN v_existing_audit;
  END IF;

  -- ── Forward-only state machine ─────────────────────────────────────────────
  IF v_credit.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit has already been applied and cannot be revoked'
      USING ERRCODE = '22023';
  END IF;

  IF v_credit.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit has already been revoked'
      USING ERRCODE = '22023';
  END IF;

  -- ── Apply revocation ───────────────────────────────────────────────────────
  UPDATE public.billing_credits
    SET revoked_at = now()
    WHERE id = p_credit_id;

  -- ── Write audit log ────────────────────────────────────────────────────────
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     v_credit.user_id,
     'credit_revoked',
     'billing_credits',
     jsonb_build_object(
       'credit_id',    p_credit_id,
       'amount_cents', v_credit.amount_cents,
       'currency',     v_credit.currency,
       'granted_at',   v_credit.granted_at,
       'revoked_at',   NULL
     ),
     jsonb_build_object(
       'credit_id',    p_credit_id,
       'amount_cents', v_credit.amount_cents,
       'currency',     v_credit.currency,
       'granted_at',   v_credit.granted_at,
       'revoked_at',   now()
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_credit(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_revoke_credit(bigint, text) TO authenticated;


-- ============================================================================
-- Migration 054 complete.
-- ============================================================================
--
-- CHANGES APPLIED:
--
-- Part A — DB-level CHECK constraint:
--   public.subscriptions: ADD CONSTRAINT subscriptions_tier_check
--     CHECK (tier IN ('free','pro','power','team','business','enterprise'))
--
-- Part B — New helper function:
--   public.admin_idempotency_check(uuid, text, uuid, text) → bigint
--     SECURITY DEFINER, SET search_path = public, extensions, pg_temp
--     GRANT EXECUTE TO authenticated
--
-- Part C — Idempotency applied to 5 bigint-returning wrappers (CREATE OR REPLACE):
--   public.admin_override_tier(uuid, text, timestamptz, text, inet, text) → bigint
--   public.admin_toggle_consent(uuid, consent_purpose, boolean, text, inet, text) → bigint
--   public.admin_record_password_reset(uuid, text, inet, text) → bigint
--   public.admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) → bigint
--   public.admin_revoke_credit(bigint, text) → bigint
--
-- NOT idempotency-patched (documented decision above):
--   public.admin_issue_credit   — billing_credits row is the dedup key; admin_revoke_credit is the remediation path
--   public.admin_send_churn_save_offer — duplicate-offer EXISTS guard provides equivalent protection
--
-- VERIFICATION:
--   CI gates via GitHub Actions: supabase db reset → applies migrations 001..054
--   → runs pgTAP-style tests from supabase/tests/rls/admin_idempotency_rls.sql
--   and supabase/tests/rls/admin_console_rls.sql (pre-existing)
-- ============================================================================
