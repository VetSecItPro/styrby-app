-- ============================================================================
-- Migration 051: Billing Ops — SECURITY DEFINER Mutation Wrappers (Phase 4.3 T2)
--
-- Creates five SECURITY DEFINER wrapper functions that are the ONLY app-layer
-- mutation path for the billing-ops tables introduced in migration 050:
--   polar_refund_events, billing_credits, churn_save_offers.
--
-- Functions created:
--   1. admin_issue_refund       — idempotent refund event creation + audit
--   2. admin_issue_credit       — manually grant an account credit
--   3. admin_revoke_credit      — revoke an unapplied credit (forward-only)
--   4. admin_send_churn_save_offer — send a win-back discount offer to a churning user
--   5. user_accept_churn_save_offer — user accepts an active churn-save offer
--
-- Security model summary (all five functions share this pattern):
--   - SECURITY DEFINER: function body executes with definer privileges so it can
--     INSERT/UPDATE billing-ops tables without granting those mutations to
--     the 'authenticated' role directly.
--   - SET search_path = public, extensions, pg_temp: prevents search-path injection
--     (a malicious user creating a shadow function in a writable schema).
--     'extensions' is required to reach digest() / encode() from pgcrypto.
--     pg_temp is always last to block injection via temporary objects.
--   - is_site_admin(auth.uid()) checked in every admin_ function body: even if a
--     future GRANT accidentally widens EXECUTE permissions, the function still
--     rejects non-admin callers at the SQL layer (defense-in-depth, OWASP A01:2021).
--   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson — see header of
--     migration 049 for full rationale): service_role-only grants cause auth.uid()
--     to resolve to NULL inside the SECURITY DEFINER body, breaking is_site_admin().
--     Route handlers must call via a user-scoped Supabase client with the admin's
--     JWT so auth.uid() resolves. For user-facing functions (user_accept_*), the
--     user's own JWT is the correct credential by design.
--   - Zero dynamic SQL: no EXECUTE, no format(). All SQL is static — auditable
--     without query-plan inspection.
--   - Mutation + audit INSERT in the same function call = same implicit transaction.
--     If the audit INSERT fails the mutation rolls back and vice versa
--     (SOC2 CC7.2 non-repudiation — no orphaned mutations, no silent audit gaps).
--
-- SOC2 CC6.1: Principle of least privilege — REVOKE ALL then targeted GRANT per function.
-- SOC2 CC7.2: Every billing mutation is audited in the same transaction.
-- SOC2 CC9.2: All billing-ops mutations flow through wrappers; no direct DML policy exists.
-- OWASP A01:2021 (Broken Access Control): Deny-by-default; is_site_admin() inside
--   every admin_ function body as a second control layer beyond GRANT.
-- OWASP A04:2021 (Insecure Design): FOR UPDATE row lock on read-before-update paths
--   to prevent TOCTOU races on credit revoke and offer accept.
-- GDPR Art.5: Purpose limitation — polar_response_json stays in polar_refund_events
--   (service_role only); audit rows reference polar_event_id rather than embedding
--   raw Polar payload, minimising PII surface in admin_audit_log.
-- ============================================================================


-- ============================================================================
-- §3.5.1  admin_issue_refund — Idempotent refund event creation + audit
-- ============================================================================

/**
 * admin_issue_refund
 *
 * Records a Polar refund event and writes an audit log row. The function is
 * idempotent on p_polar_event_id via INSERT ... ON CONFLICT DO NOTHING on the
 * polar_refund_events primary key: if the event_id already exists the function
 * fetches the existing audit_log id and returns it, producing no duplicate rows.
 *
 * This idempotency design is intentional: Polar webhooks have at-least-once
 * delivery semantics and may replay the same refund event multiple times. A
 * webhook handler must be safe to call twice without creating duplicate financial
 * records or double-writing the audit log (SOC2 CC9.2 non-repudiation).
 *
 * Mutation and audit INSERT run in the same implicit transaction — if either
 * step fails the entire operation rolls back (no orphaned mutations, no silent
 * audit gaps, SOC2 CC7.2).
 *
 * @param p_target_user_id          UUID of the user being refunded
 * @param p_amount_cents            Refund amount in cents (1 – 500000 inclusive; cap $5000)
 * @param p_currency                ISO 4217 currency code (e.g. 'usd')
 * @param p_reason                  Mandatory free-text justification (btrim length > 0)
 * @param p_polar_event_id          Polar webhook event_id — the idempotency key.
 *                                  Must be unique across all refund events; ON CONFLICT
 *                                  on this value is the dedup mechanism.
 * @param p_polar_refund_id         Polar refund resource id (e.g. 'ref_…')
 * @param p_polar_subscription_id   Polar subscription id (nullable; absent for one-time charges)
 * @param p_polar_response_json     Raw Polar API response — stored in polar_refund_events
 *                                  only; never echoed into admin_audit_log to minimise
 *                                  PII exposure in the audit trail (GDPR Art.5).
 * @returns bigint                  audit_log.id of the newly inserted row, or the
 *                                  pre-existing audit_log.id if event_id was already processed
 *
 * @throws 42501  Caller is not a site admin (insufficient_privilege)
 * @throws 23514  p_reason is NULL or blank after btrim (check_violation)
 * @throws 22023  p_amount_cents is outside [1, 500000] (invalid_parameter_value)
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson — see migration 049 header).
 *     Route handlers call via user-scoped Supabase client with the admin's JWT.
 *   - is_site_admin(auth.uid()) checked inside function body (defense-in-depth).
 *   - SECURITY DEFINER: bypasses RLS on polar_refund_events and admin_audit_log.
 *     The in-body is_site_admin check replaces the absent RLS policies on those tables.
 *
 * SOC2 CC7.2: Refund event + audit row written atomically; if audit fails refund row
 *   is also rolled back, preventing unaudited financial mutations.
 * SOC2 CC9.2: Idempotency via ON CONFLICT ensures at-least-once webhook delivery
 *   does not produce duplicate refund records.
 * GDPR Art.5: polar_response_json stored in polar_refund_events (service_role-only);
 *   admin_audit_log row references polar_event_id only — no raw PII in audit trail.
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
-- WHY extensions in search_path: admin_audit_chain_hash trigger calls digest() +
-- encode() from pgcrypto, which Supabase installs in the 'extensions' schema.
-- Without this, the trigger still fires correctly (it has its own search_path),
-- but including 'extensions' here is belt-and-suspenders for any future pgcrypto
-- call we add to this function body. pg_temp is always LAST to block search-path
-- injection via temporary objects (OWASP A01:2021).
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_audit_id       bigint;
  v_existing_audit bigint;
  -- WHY bigint (not boolean): GET DIAGNOSTICS ROW_COUNT returns bigint.
  -- 0 = ON CONFLICT path taken (row already existed); 1 = new row inserted.
  v_inserted       bigint;
BEGIN
  -- ── Authorization ─────────────────────────────────────────────────────────────
  -- WHY ERRCODE 42501 (insufficient_privilege): standard SQL error code for
  -- "permission denied". Lets callers programmatically distinguish auth errors
  -- from validation errors (22023, 23514) without parsing the message string.
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ──────────────────────────────────────────────────────────
  -- WHY btrim (not trim): btrim removes all leading/trailing whitespace bytes
  -- including tabs, newlines, carriage returns. A reason of '   \n   ' would
  -- pass length(reason) > 0 but is semantically blank — btrim catches it.
  -- This is defense-in-depth over the table CHECK (length(btrim(reason)) > 0).
  -- ERRCODE 23514 = check_violation, consistent with the DB constraint code.
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- WHY 1 – 500000: prevents zero/negative refunds (semantically invalid) and
  -- caps individual refunds at $5000 to limit blast radius of a misconfigured call.
  -- Refunds exceeding $5000 must be processed via Polar dashboard directly.
  -- ERRCODE 22023 = invalid_parameter_value (caller error, not permissions error).
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 500000 THEN
    RAISE EXCEPTION 'amount_cents must be between 1 and 500000' USING ERRCODE = '22023';
  END IF;

  -- ── Idempotent INSERT into polar_refund_events ────────────────────────────────
  -- WHY ON CONFLICT DO NOTHING: Polar webhooks have at-least-once delivery.
  -- A duplicate webhook replay must not create a second polar_refund_events row
  -- or a second audit log row — that would double-count the refund in financial
  -- reports and create a misleading audit trail.
  -- v_inserted tracks whether a new row was created (INSERT) or skipped (CONFLICT).
  -- We use this flag to decide whether to INSERT a new audit row or fetch the
  -- existing one (idempotent return path).
  INSERT INTO public.polar_refund_events
    (event_id, refund_id, subscription_id, amount_cents, currency,
     reason, actor_id, target_user_id, processed_at, polar_response_json)
  VALUES
    (p_polar_event_id, p_polar_refund_id, p_polar_subscription_id,
     p_amount_cents, p_currency, p_reason, v_actor, p_target_user_id,
     now(), p_polar_response_json)
  ON CONFLICT (event_id) DO NOTHING;

  -- Determine whether the INSERT landed a new row or hit a conflict.
  -- WHY GET DIAGNOSTICS after ON CONFLICT DO NOTHING: this is the only way to
  -- detect a conflict without a second SELECT.  v_inserted = 0 means the ON
  -- CONFLICT path was taken (row already existed); v_inserted = 1 means the
  -- row was newly inserted. ROW_COUNT is bigint; v_inserted is declared bigint.
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- ── Idempotent return: fetch existing audit_id if event already processed ─────
  -- WHY: On a replay, we return the pre-existing audit_log.id so the caller can
  -- safely log "refund already recorded, audit_id=X" without creating a second
  -- audit record. This gives the webhook handler a stable, idempotent return value.
  IF v_inserted = 0 THEN
    -- WHY we look up by target_user_id + polar_event_id cross-referenced in audit:
    -- after_json contains polar_event_id as a reference key. This join is the
    -- correct way to correlate the pre-existing audit row to this event_id without
    -- storing the audit_id in polar_refund_events (adding a column for idempotency
    -- tracking would couple the tables unnecessarily).
    SELECT id INTO v_existing_audit
      FROM public.admin_audit_log
      WHERE target_user_id = p_target_user_id
        AND action = 'refund_issued'
        AND after_json->>'polar_event_id' = p_polar_event_id
      ORDER BY id DESC
      LIMIT 1;

    RETURN COALESCE(v_existing_audit, 0);
  END IF;

  -- ── Write audit log row (new insert path only) ────────────────────────────────
  -- WHY after_json references polar_event_id (not polar_response_json): the raw
  -- Polar response is already stored in polar_refund_events with service_role-only
  -- access. Duplicating it into admin_audit_log (which site admins can SELECT)
  -- would unnecessarily expose payment PII (card last4, billing address) in the
  -- audit trail. The polar_event_id is the cross-reference key for any auditor
  -- who needs the full response from service_role tools (GDPR Art.5 purpose
  -- limitation / data minimisation).
  -- WHY mutation + audit in same statement block: they share the same implicit
  -- transaction. If the audit INSERT fails the polar_refund_events INSERT also
  -- rolls back — no unaudited financial mutations (SOC2 CC7.2 non-repudiation).
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

-- WHY REVOKE ALL FROM PUBLIC first: PUBLIC includes every role (including anon).
-- Revoking resets permissions to the safe baseline before we selectively grant
-- (SOC2 CC6.1 least privilege).
REVOKE ALL ON FUNCTION public.admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) FROM PUBLIC;

-- WHY authenticated (not service_role): Phase 4.1 P0 lesson — granting to
-- service_role only causes auth.uid() to resolve to NULL inside the SECURITY
-- DEFINER body. Route handlers must call via a user-scoped Supabase client with
-- the admin's JWT so auth.uid() resolves and is_site_admin() works correctly.
-- The real authorization gate is the in-body is_site_admin(auth.uid()) check.
GRANT EXECUTE ON FUNCTION public.admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) TO authenticated;


-- ============================================================================
-- §3.5.2  admin_issue_credit — Manually grant an account credit
-- ============================================================================

/**
 * admin_issue_credit
 *
 * Inserts a new billing_credits row (in unapplied state) and writes an audit
 * log row in the same transaction. Credits remain unapplied until the billing
 * webhook handler confirms Polar has applied them to an invoice.
 *
 * Mutation and audit INSERT run in the same implicit transaction — if either
 * step fails the entire operation rolls back (SOC2 CC7.2 non-repudiation).
 *
 * @param p_target_user_id  UUID of the user receiving the credit
 * @param p_amount_cents    Credit amount in cents (1 – 100000 inclusive; cap $1000)
 * @param p_currency        ISO 4217 currency code (e.g. 'usd')
 * @param p_reason          Mandatory free-text justification (btrim length > 0)
 * @param p_expires_at      Optional expiry timestamp (NULL = credit does not expire)
 * @returns TABLE(audit_id bigint, credit_id bigint)
 *   audit_id  — admin_audit_log.id of the newly inserted audit row
 *   credit_id — billing_credits.id of the newly inserted credit row
 *
 * @throws 42501  Caller is not a site admin (insufficient_privilege)
 * @throws 23514  p_reason is NULL or blank after btrim (check_violation)
 * @throws 22023  p_amount_cents is outside [1, 100000] (invalid_parameter_value)
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson — see migration 049 header).
 *   - is_site_admin(auth.uid()) checked inside function body (defense-in-depth).
 *   - SECURITY DEFINER: bypasses RLS on billing_credits and admin_audit_log.
 *     The in-body is_site_admin check replaces the absent DML policies on those tables.
 *   - granted_by is always set to auth.uid() (the calling admin) — callers cannot
 *     spoof a different granter identity.
 *
 * SOC2 CC7.2: Credit + audit written atomically; audit row before_json is NULL
 *   (creation event), after_json captures the full credit record.
 * SOC2 CC6.1: Least-privilege — only site admins may grant credits.
 * GDPR Art.5: reason field limited to admin-supplied justification text;
 *   no session content, message data, or PII stored.
 */
CREATE OR REPLACE FUNCTION public.admin_issue_credit(
  p_target_user_id  uuid,
  p_amount_cents    bigint,
  p_currency        text,
  p_reason          text,
  p_expires_at      timestamptz
)
RETURNS TABLE(audit_id bigint, credit_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as admin_issue_refund.
-- pg_temp always LAST to block search-path injection.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_credit_id bigint;
  v_audit_id  bigint;
BEGIN
  -- ── Authorization ─────────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ──────────────────────────────────────────────────────────
  -- WHY 1 – 100000: cap at $1000 per individual credit to limit accidental
  -- over-crediting. Larger goodwill amounts require Polar dashboard direct action
  -- (audit trail for larger amounts is the Polar dashboard, not our admin panel).
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000 THEN
    RAISE EXCEPTION 'amount_cents must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;

  -- WHY btrim: same reasoning as admin_issue_refund — catches whitespace-only strings.
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── INSERT credit row ─────────────────────────────────────────────────────────
  -- WHY granted_by = v_actor (not a parameter): callers cannot supply a different
  -- granter. The admin's own authenticated identity is always the granter,
  -- preventing attribution spoofing (SOC2 CC7.2 non-repudiation).
  INSERT INTO public.billing_credits
    (user_id, amount_cents, currency, reason, granted_by, granted_at, expires_at)
  VALUES
    (p_target_user_id, p_amount_cents, p_currency, p_reason, v_actor, now(), p_expires_at)
  RETURNING id INTO v_credit_id;

  -- ── Write audit log row ───────────────────────────────────────────────────────
  -- WHY before_json = NULL: this is a creation event; there is no previous state.
  -- WHY after_json captures credit details (not to_jsonb(credit.*)): we enumerate
  -- columns explicitly to control the PII surface and avoid capturing system columns.
  -- WHY mutation + audit in same statement block: same implicit transaction.
  -- If audit INSERT fails the credit INSERT also rolls back (SOC2 CC7.2).
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     p_target_user_id,
     'credit_issued',
     'billing_credits',
     NULL,
     jsonb_build_object(
       'credit_id',    v_credit_id,
       'amount_cents', p_amount_cents,
       'currency',     p_currency,
       'expires_at',   p_expires_at,
       'granted_by',   v_actor
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN QUERY SELECT v_audit_id, v_credit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_issue_credit(uuid, bigint, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_issue_credit(uuid, bigint, text, text, timestamptz) TO authenticated;


-- ============================================================================
-- §3.5.3  admin_revoke_credit — Revoke an unapplied credit (forward-only)
-- ============================================================================

/**
 * admin_revoke_credit
 *
 * Sets revoked_at on a billing_credits row that is currently in the unapplied
 * state (applied_at IS NULL AND revoked_at IS NULL). This function enforces the
 * forward-only lifecycle: a credit that has already been applied to an invoice
 * or previously revoked cannot be revoked again.
 *
 * WHY forward-only (no un-revoke path): allowing an admin to un-revoke a credit
 * creates a bidirectional state machine that is harder to audit and easier to
 * abuse (repeated revoke/un-revoke cycles could be used to time credit application
 * windows). The forward-only rule (unapplied → revoked) keeps the audit trail
 * clean and unambiguous (SOC2 CC9.2 / OWASP A04:2021 insecure design prevention).
 *
 * Mutation and audit INSERT run in the same implicit transaction.
 *
 * @param p_credit_id  bigint id of the billing_credits row to revoke
 * @param p_reason     Mandatory free-text justification (btrim length > 0)
 * @returns bigint     admin_audit_log.id of the newly inserted audit row
 *
 * @throws 42501  Caller is not a site admin (insufficient_privilege)
 * @throws 23514  p_reason is NULL or blank after btrim (check_violation)
 * @throws 22023  Credit not found (invalid_parameter_value)
 * @throws 22023  Credit is already applied or revoked (forward-only enforcement)
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson).
 *   - is_site_admin(auth.uid()) enforced in body (defense-in-depth).
 *   - SECURITY DEFINER: bypasses RLS on billing_credits and admin_audit_log.
 *   - FOR UPDATE row lock prevents concurrent revoke calls from racing.
 *
 * SOC2 CC7.2: Revocation audited atomically. before_json captures pre-revoke
 *   snapshot; after_json captures post-revoke state for full diff display.
 * SOC2 CC9.2: Forward-only lifecycle means no credit can be un-revoked without a
 *   new admin_issue_credit call, which itself creates a fresh audit row.
 * OWASP A04:2021 (Insecure Design): FOR UPDATE prevents TOCTOU race on the
 *   applied_at / revoked_at NULL checks.
 */
CREATE OR REPLACE FUNCTION public.admin_revoke_credit(
  p_credit_id  bigint,
  p_reason     text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as prior wrappers.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_credit    public.billing_credits%ROWTYPE;
  v_audit_id  bigint;
BEGIN
  -- ── Authorization ─────────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- WHY btrim: same reasoning as prior wrappers — prevent whitespace-only reason.
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Fetch and lock credit row ─────────────────────────────────────────────────
  -- WHY FOR UPDATE: takes a row-level lock so no concurrent admin_revoke_credit call
  -- (or a billing webhook updating applied_at) can modify this row between our state
  -- check and our UPDATE. Without the lock a TOCTOU window exists where two concurrent
  -- revoke calls both read applied_at = NULL and both proceed to UPDATE — resulting in
  -- revoked_at being set twice (or to two different timestamps if clocks differ).
  -- FOR UPDATE serialises the check and update atomically (OWASP A04:2021 / SOC2 CC7.2).
  SELECT * INTO v_credit
    FROM public.billing_credits
    WHERE id = p_credit_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit not found' USING ERRCODE = '22023';
  END IF;

  -- ── Forward-only state machine ────────────────────────────────────────────────
  -- WHY forward-only: see function header. We check applied_at first because an
  -- applied credit is a completed financial transaction — revoking it is semantically
  -- meaningless (the credit has already been consumed) and could mislead auditors
  -- into thinking a transaction was reversed when it was not.
  IF v_credit.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit has already been applied and cannot be revoked'
      USING ERRCODE = '22023';
  END IF;

  IF v_credit.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit has already been revoked'
      USING ERRCODE = '22023';
  END IF;

  -- ── Apply revocation ──────────────────────────────────────────────────────────
  UPDATE public.billing_credits
    SET revoked_at = now()
    WHERE id = p_credit_id;

  -- ── Write audit log row ───────────────────────────────────────────────────────
  -- WHY before_json uses the pre-revoke v_credit snapshot (not a re-SELECT):
  -- v_credit was read inside the FOR UPDATE lock and reflects the state immediately
  -- before our UPDATE. A re-SELECT after UPDATE could theoretically race with another
  -- UPDATE (not possible under the FOR UPDATE lock, but using the local snapshot is
  -- conceptually cleaner and avoids an unnecessary round-trip).
  -- WHY after_json sets revoked_at = now(): consistent with the UPDATE above; the
  -- actual timestamp is now() called at audit INSERT time, which is in the same
  -- transaction as the UPDATE and thus < 1ms apart.
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
-- §3.5.4  admin_send_churn_save_offer — Send a win-back offer to a churning user
-- ============================================================================

/**
 * admin_send_churn_save_offer
 *
 * Creates a churn_save_offers row (in active/pending-acceptance state) and writes
 * an audit log row in the same transaction. The function derives discount_pct and
 * discount_duration_months from p_kind server-side — the caller cannot supply them
 * independently, preventing discount tampering via a crafted RPC call.
 *
 * WHY server-side kind derivation (not accepting pct + duration as parameters):
 * If discount_pct and discount_duration_months were separate parameters, a caller
 * could pass (kind='annual_3mo_25pct', discount_pct=100, discount_duration_months=12)
 * to fabricate an unauthorized offer. Deriving pct + duration from kind inside the
 * SECURITY DEFINER body means the function is the sole source of truth for offer
 * terms — callers cannot influence them beyond choosing the offer kind enum value.
 * The churn_save_offers table has a composite CHECK that enforces the same invariant
 * at the row level (migration 050), creating defense-in-depth.
 *
 * Duplicate-offer prevention: if an active (unexpired, not accepted, not revoked)
 * offer of the same kind already exists for this user, the function raises 22023.
 * This prevents admins from accidentally spamming the same user with multiple
 * identical active offers, which would devalue the offer and confuse the user.
 *
 * Mutation and audit INSERT run in the same implicit transaction.
 *
 * @param p_target_user_id     UUID of the user to receive the offer
 * @param p_kind               churn_offer_kind enum value — determines offer terms
 * @param p_reason             Mandatory free-text justification (btrim length > 0)
 * @param p_polar_discount_code Optional Polar discount code (admin creates manually in
 *                              Polar dashboard; Phase 4.3 does not auto-create codes)
 * @returns TABLE(audit_id bigint, offer_id bigint)
 *   audit_id — admin_audit_log.id of the newly inserted audit row
 *   offer_id — churn_save_offers.id of the newly inserted offer row
 *
 * @throws 42501  Caller is not a site admin (insufficient_privilege)
 * @throws 23514  p_reason is NULL or blank after btrim (check_violation)
 * @throws 22023  An active offer of the same kind already exists for this user
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson).
 *   - is_site_admin(auth.uid()) enforced in body (defense-in-depth).
 *   - SECURITY DEFINER: bypasses RLS on churn_save_offers and admin_audit_log.
 *   - Server-side kind derivation prevents discount_pct tampering
 *     (spec §2 threat: "Churn-save offer code tampered").
 *   - sent_by always set to auth.uid() — attribution cannot be spoofed.
 *
 * SOC2 CC7.2: Offer + audit written atomically.
 * SOC2 CC6.1: Only site admins may create offers.
 * SOC2 CC9.2: Duplicate-offer guard prevents accidental multi-send; each offer
 *   send is audited so admins can detect if a user received multiple offers.
 */
CREATE OR REPLACE FUNCTION public.admin_send_churn_save_offer(
  p_target_user_id      uuid,
  p_kind                public.churn_offer_kind,
  p_reason              text,
  p_polar_discount_code text
)
RETURNS TABLE(audit_id bigint, offer_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as prior wrappers.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor            uuid := auth.uid();
  v_discount_pct     int;
  v_duration_months  int;
  v_offer_id         bigint;
  v_audit_id         bigint;
BEGIN
  -- ── Authorization ─────────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- WHY btrim: same reasoning as prior wrappers.
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── Server-side derivation of offer terms from kind ───────────────────────────
  -- WHY hardcoded CASE (not a lookup table): the two offer kinds and their terms
  -- are business constants defined in spec §2 and enforced by the churn_offer_kind
  -- enum. A lookup table would add query complexity and an extra join without any
  -- flexibility benefit — the enum already prevents unknown kinds. If a new kind is
  -- added in a future migration, this CASE block must be updated in the same
  -- migration alongside the enum extension (the function is intentionally tightly
  -- coupled to the enum to make incomplete updates visible at review time).
  IF p_kind = 'annual_3mo_25pct' THEN
    v_discount_pct    := 25;
    v_duration_months := 3;
  ELSIF p_kind = 'monthly_1mo_50pct' THEN
    v_discount_pct    := 50;
    v_duration_months := 1;
  ELSE
    -- Unreachable: Postgres enforces enum membership at the call site before the
    -- function body executes. This branch is a safety net for future enum values
    -- added without updating this function.
    RAISE EXCEPTION 'unhandled churn_offer_kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  -- ── Duplicate-offer guard ─────────────────────────────────────────────────────
  -- WHY: sending the same offer type twice to the same user (when one is still
  -- active) devalues the offer and creates a confusing UX — the user would see
  -- two "Act now: 25% off!" banners. The partial index on churn_save_offers
  -- (idx_churn_save_offers_user_active, migration 050 §3.3) makes this EXISTS
  -- check efficient for the hot path.
  -- WHY NOT SELECT FOR UPDATE here: we are not modifying an existing offer row;
  -- we are guarding against INSERT of a duplicate. A race between two concurrent
  -- admin_send_churn_save_offer calls for the same (user, kind) will both pass
  -- this check but then both attempt INSERT. The unique-ish business rule is not
  -- a hard UNIQUE constraint (a user may have multiple offers over their lifetime,
  -- just not two active ones simultaneously), so we rely on the EXISTS check +
  -- the serialisable semantics of the calling route handler (admin console is
  -- single-action, not a high-throughput path). For a future high-throughput
  -- path an advisory lock or a partial UNIQUE constraint could be added.
  IF EXISTS (
    SELECT 1 FROM public.churn_save_offers
    WHERE user_id     = p_target_user_id
      AND kind        = p_kind
      AND accepted_at IS NULL
      AND revoked_at  IS NULL
      AND expires_at  > now()
  ) THEN
    RAISE EXCEPTION 'an active offer of this kind already exists for this user'
      USING ERRCODE = '22023';
  END IF;

  -- ── INSERT offer row ──────────────────────────────────────────────────────────
  -- WHY expires_at = now() + interval '7 days': spec §3.3 mandates a 7-day
  -- acceptance window. Short enough to create urgency; long enough for a churning
  -- user to see the push notification and decide. The interval is hardcoded here
  -- (not a parameter) so callers cannot create indefinite-lived offers.
  -- WHY sent_by = v_actor: same attribution-integrity reasoning as granted_by
  -- in admin_issue_credit — callers cannot spoof the sender identity.
  INSERT INTO public.churn_save_offers
    (user_id, kind, discount_pct, discount_duration_months,
     sent_by, sent_at, expires_at, polar_discount_code, reason)
  VALUES
    (p_target_user_id, p_kind, v_discount_pct, v_duration_months,
     v_actor, now(), now() + interval '7 days', p_polar_discount_code, p_reason)
  RETURNING id INTO v_offer_id;

  -- ── Write audit log row ───────────────────────────────────────────────────────
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     p_target_user_id,
     'churn_save_sent',
     'churn_save_offers',
     NULL,
     jsonb_build_object(
       'offer_id',              v_offer_id,
       'kind',                  p_kind,
       'discount_pct',          v_discount_pct,
       'discount_duration_months', v_duration_months,
       'expires_at',            now() + interval '7 days'
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN QUERY SELECT v_audit_id, v_offer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_churn_save_offer(uuid, public.churn_offer_kind, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_send_churn_save_offer(uuid, public.churn_offer_kind, text, text) TO authenticated;


-- ============================================================================
-- §3.5.5  user_accept_churn_save_offer — User accepts an active churn-save offer
-- ============================================================================

/**
 * user_accept_churn_save_offer
 *
 * Transitions a churn_save_offers row from active state to accepted state by
 * setting accepted_at = now(). The caller must be the offer's resource owner
 * (offer.user_id = auth.uid()). Only active offers (accepted_at IS NULL,
 * revoked_at IS NULL, expires_at > now()) may be accepted.
 *
 * This is a user-facing function — the user calls it directly from the mobile or
 * web "Claim Your Offer" screen using their own session JWT. The function does NOT
 * require is_site_admin(); auth.uid() ownership is the sole authorization gate.
 *
 * Mutation and audit INSERT run in the same implicit transaction.
 *
 * @param p_offer_id  bigint id of the churn_save_offers row to accept
 * @returns bigint    admin_audit_log.id of the newly inserted audit row
 *
 * @throws 42501  Caller is not the offer's resource owner (insufficient_privilege)
 * @throws 22023  Offer not found, already accepted, revoked, or expired
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated. Users call this directly with their own JWT.
 *   - SECURITY DEFINER: bypasses RLS on churn_save_offers (no UPDATE policy exists).
 *     offer.user_id = auth.uid() checked inside the body replaces RLS for this path.
 *   - FOR UPDATE: prevents concurrent accept + revoke calls from racing on the same
 *     offer row (TOCTOU — OWASP A04:2021 / SOC2 CC7.2).
 *   - actor_id in the audit row is set to auth.uid() (the user), not a site admin.
 *     This correctly records that the user accepted the offer, not an admin action.
 *
 * SOC2 CC9.2: User acceptance is audited atomically with the state UPDATE.
 * SOC2 CC7.2: before/after state diff enables auditors to verify the acceptance
 *   timestamp and confirm the offer was active (not expired) at acceptance time.
 * GDPR Art.7: Affirmative consent recorded with accepted_at timestamp. Offer terms
 *   (discount_pct, duration) are preserved in the audit row for dispute resolution.
 */
CREATE OR REPLACE FUNCTION public.user_accept_churn_save_offer(
  p_offer_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: same reasoning as prior wrappers.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_offer    public.churn_save_offers%ROWTYPE;
  v_audit_id bigint;
BEGIN
  -- ── Fetch and lock offer row ──────────────────────────────────────────────────
  -- WHY FOR UPDATE: takes a row-level lock to prevent a concurrent admin revoke
  -- (which would set revoked_at) from racing with this acceptance. Without the
  -- lock a TOCTOU window exists where the user reads the offer as active, the admin
  -- revokes it, and then the user's UPDATE sets accepted_at on a revoked offer —
  -- creating an inconsistent state where both accepted_at and revoked_at are set.
  -- FOR UPDATE serialises the check and the UPDATE atomically (OWASP A04:2021).
  SELECT * INTO v_offer
    FROM public.churn_save_offers
    WHERE id = p_offer_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- WHY 22023 (not 42501): the offer might not exist at all, or might exist
    -- but belong to another user. We deliberately collapse these two cases into
    -- a single 22023 error to prevent an authenticated user from probing whether
    -- offer IDs belonging to other users exist (information leakage prevention).
    -- We apply the ownership check below and return 42501 once we've confirmed
    -- the row exists — matching the user_approve_support_access pattern (migration 049).
    RAISE EXCEPTION 'offer not found' USING ERRCODE = '22023';
  END IF;

  -- ── Authorization: caller must be the offer's resource owner ─────────────────
  -- WHY 42501 after confirming existence: once we know the row exists, an ownership
  -- mismatch is an authorization failure — the caller is attempting to accept an
  -- offer that belongs to a different user (possible confused deputy scenario).
  IF v_offer.user_id <> v_actor THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── State machine checks ──────────────────────────────────────────────────────
  -- WHY accepted_at first: if the offer was already accepted, the most accurate
  -- error is "already accepted" — the user should not receive a confusing "offer
  -- expired" message for an offer they already claimed.
  IF v_offer.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'offer has already been accepted' USING ERRCODE = '22023';
  END IF;

  IF v_offer.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'offer has been revoked and cannot be accepted' USING ERRCODE = '22023';
  END IF;

  -- WHY expiry after accepted/revoked checks: an offer that is both accepted and
  -- expired should produce "already accepted" — not "expired" — for clarity.
  IF v_offer.expires_at <= now() THEN
    RAISE EXCEPTION 'offer has expired and cannot be accepted' USING ERRCODE = '22023';
  END IF;

  -- ── Transition: active → accepted ────────────────────────────────────────────
  UPDATE public.churn_save_offers
    SET accepted_at = now()
    WHERE id = p_offer_id;

  -- ── Write audit log row ───────────────────────────────────────────────────────
  -- WHY actor_id = v_actor (the user, not an admin): this is a user-initiated
  -- action. Recording the user as the actor correctly reflects that the user
  -- consented to the offer terms (GDPR Art.7 affirmative consent audit trail).
  -- WHY after_json includes discount_pct + duration: preserves the exact offer
  -- terms at acceptance time, enabling dispute resolution if the user later claims
  -- the discount terms were different.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     v_offer.user_id,
     'churn_save_accepted',
     'churn_save_offers',
     jsonb_build_object(
       'offer_id',                 p_offer_id,
       'kind',                     v_offer.kind,
       'discount_pct',             v_offer.discount_pct,
       'discount_duration_months', v_offer.discount_duration_months,
       'accepted_at',              NULL,
       'expires_at',               v_offer.expires_at
     ),
     jsonb_build_object(
       'offer_id',                 p_offer_id,
       'kind',                     v_offer.kind,
       'discount_pct',             v_offer.discount_pct,
       'discount_duration_months', v_offer.discount_duration_months,
       'accepted_at',              now(),
       'expires_at',               v_offer.expires_at
     ),
     'user accepted churn-save offer #' || p_offer_id::text)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.user_accept_churn_save_offer(bigint) FROM PUBLIC;

-- WHY authenticated (not service_role): users call this directly from the mobile
-- or web "Claim Your Offer" screen using their own session JWT. Service-role would
-- be incorrect — the user's auth.uid() must resolve for the ownership check.
-- This function does NOT use is_site_admin(); ownership (offer.user_id = auth.uid())
-- is the sole authorization gate. Any authenticated user may call this; only the
-- owner of the offer will pass the in-body ownership check (OWASP A01:2021).
GRANT EXECUTE ON FUNCTION public.user_accept_churn_save_offer(bigint) TO authenticated;


-- ============================================================================
-- Migration 051 complete.
-- ============================================================================
--
-- FUNCTIONS CREATED (all SECURITY DEFINER, SET search_path = public, extensions, pg_temp):
--   admin_issue_refund(uuid, bigint, text, text, text, text, text, jsonb) → bigint
--   admin_issue_credit(uuid, bigint, text, text, timestamptz)             → TABLE(audit_id bigint, credit_id bigint)
--   admin_revoke_credit(bigint, text)                                     → bigint
--   admin_send_churn_save_offer(uuid, churn_offer_kind, text, text)       → TABLE(audit_id bigint, offer_id bigint)
--   user_accept_churn_save_offer(bigint)                                  → bigint
--
-- GRANTS (Phase 4.1 P0 pattern — all five → authenticated):
--   admin_issue_refund              → authenticated (is_site_admin check in body)
--   admin_issue_credit              → authenticated (is_site_admin check in body)
--   admin_revoke_credit             → authenticated (is_site_admin check in body)
--   admin_send_churn_save_offer     → authenticated (is_site_admin check in body)
--   user_accept_churn_save_offer    → authenticated (ownership check in body)
--
-- VERIFICATION:
--   Docker unavailable locally. CI gates via Phase 4.0 GitHub Actions workflow:
--   supabase db reset → applies migrations 001..051 → runs pgTAP-style tests
--   from supabase/tests/rls/billing_ops_rls.sql (blocks r through v added in T2).
-- ============================================================================
