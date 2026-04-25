-- ============================================================================
-- Migration 056: Phase 4 Audit Coverage Gap + Idempotency Extension Bundle
--
-- Closes three SEC findings opened during the post-Phase-4 hardening sweep.
-- All changes are schema-only — no production data is touched.
--
-- ─── Change 1 — SEC-ADV-005 (audit_trigger_fn coverage gap) ─────────────────
--   Migration 053 re-attached audit_trigger_fn to 5 tables (profiles,
--   subscriptions, api_keys, team_members, team_policies). Three Phase 4
--   tables landed AFTER 053 without an audit trigger:
--     - billing_credits      (migration 050)
--     - churn_save_offers    (migration 050)
--     - support_access_grants (migration 048)
--   Service-role writes (Supabase dashboard, psql, pg_cron jobs, Edge
--   Functions) currently mutate these rows leaving NO audit trail. SOC2
--   CC7.2 (non-repudiation) requires every privileged data mutation to
--   produce an audit_log row regardless of the application code path.
--   Fix: attach audit_trigger_fn AFTER INSERT OR UPDATE OR DELETE on each
--   of the three tables, matching the pattern used in migration 018/053.
--
-- ─── Change 2 — SEC-SM-001 (admin idempotency coverage gap) ─────────────────
--   Migration 054 added admin_idempotency_check() and applied it to 5
--   bigint-returning admin wrappers, but skipped the 2 TABLE-returning
--   wrappers (admin_issue_credit, admin_send_churn_save_offer) on the
--   reasoning that "data-layer guards already exist". That reasoning is
--   incorrect for the double-click race window:
--     - admin_issue_credit: two clicks within <500ms both pass the
--       is_site_admin gate, both INSERT into billing_credits, and both
--       INSERT into admin_audit_log. The duplicate billing_credits rows
--       are detectable but the duplicate audit rows degrade the audit
--       trail's trustworthiness (SOC2 CC7.2 non-repudiation).
--     - admin_send_churn_save_offer: the EXISTS guard checks for an
--       active offer of the same kind, but two concurrent INSERTs in the
--       same transaction window both pass the EXISTS check before either
--       commits — TOCTOU race. The advisory-lock check serialises them.
--   Fix: CREATE OR REPLACE both functions with admin_idempotency_check()
--   called at the top of the body. The action strings ('credit_issued'
--   and 'churn_save_sent') match the audit row written below so the
--   pre-check SELECT inside the helper finds the duplicate.
--   For TABLE-returning functions we recover credit_id / offer_id from
--   the existing audit row's after_json on the dedup-hit path.
--
-- ─── Change 3 — SEC-IDEM-001 (refund idempotency key collision) ─────────────
--   admin_issue_refund's advisory-lock signature in migration 054 is
--   (actor_id, action, target_user_id, btrim(reason), minute-bucket).
--   Two distinct Polar refund events for the same user, with the same
--   actor (or service-role) and the same human-readable reason text, that
--   both arrive within the same UTC minute, would collapse into a single
--   audit row — the second event's audit INSERT is silently suppressed
--   even though the polar_refund_events ON CONFLICT (event_id) path would
--   have produced a fresh event row. This is a real failure mode for
--   batched Polar webhook deliveries (e.g. a billing job processes a
--   refund batch with the same generic reason "monthly cleanup").
--   Fix: introduce admin_idempotency_check_with_event() — a sibling
--   helper that includes a billing-event identifier in the lock key. The
--   admin_issue_refund wrapper switches to this helper, passing
--   p_polar_event_id as the additional discriminator. Distinct billing
--   events now never collapse regardless of reason or minute bucket.
--   The original admin_idempotency_check() helper is unchanged so the 5
--   non-billing wrappers updated in 054 are untouched.
--
-- IDEMPOTENCY (Phase 4.0 CI runs `supabase db reset` twice):
--   - Triggers: DROP TRIGGER IF EXISTS before CREATE TRIGGER.
--   - Functions: CREATE OR REPLACE FUNCTION (no DROP).
--   - No data writes. Re-running this migration is a no-op.
--
-- SOC2 CC7.2: every privileged data mutation produces exactly one audit row.
-- SOC2 CC9.2: idempotency across billing paths prevents financial double-writes.
-- OWASP A04:2021 (Insecure Design): pg_advisory_xact_lock prevents TOCTOU on
--   the SELECT-then-INSERT path inside each admin wrapper.
-- ============================================================================


-- ============================================================================
-- §1. SEC-ADV-005 — Attach audit_trigger_fn to 3 Phase 4 tables
-- ============================================================================

-- WHY DROP TRIGGER IF EXISTS first: Postgres has no `CREATE TRIGGER IF NOT
-- EXISTS` form. Repeated migration apply (CI db-reset twice) would fail the
-- second pass with "trigger already exists". The DROP is harmless on the
-- first pass (trigger does not exist yet) and idempotent thereafter.

DROP TRIGGER IF EXISTS audit_log_billing_credits        ON public.billing_credits;
CREATE TRIGGER audit_log_billing_credits
  AFTER INSERT OR UPDATE OR DELETE ON public.billing_credits
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

DROP TRIGGER IF EXISTS audit_log_churn_save_offers      ON public.churn_save_offers;
CREATE TRIGGER audit_log_churn_save_offers
  AFTER INSERT OR UPDATE OR DELETE ON public.churn_save_offers
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

DROP TRIGGER IF EXISTS audit_log_support_access_grants  ON public.support_access_grants;
CREATE TRIGGER audit_log_support_access_grants
  AFTER INSERT OR UPDATE OR DELETE ON public.support_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();


-- ============================================================================
-- §2. SEC-IDEM-001 — admin_idempotency_check_with_event() helper
-- ============================================================================

/**
 * admin_idempotency_check_with_event
 *
 * Same algorithm as admin_idempotency_check (migration 054) but extends the
 * advisory-lock key with a billing-event identifier (e.g. polar_event_id).
 * Use this helper from any wrapper where the admin "reason" is not a stable
 * idempotency discriminator — typically Polar-webhook-driven mutations where
 * many distinct events share the same reason string within a one-minute bucket.
 *
 * Lock key composition:
 *   actor_id || action || target_user_id || btrim(reason) ||
 *   COALESCE(p_event_id, '') || date_trunc('minute', now())
 *
 * WHY a separate helper (not a parameter on the original): the 5 wrappers
 * already updated in 054 do NOT have a billing-event identifier and must
 * keep their existing key shape. Adding a defaulted parameter to the
 * original helper would change its function signature and trip the
 * rpc-contract-sync test for callers that pass the param positionally.
 * A sibling helper keeps the original signature intact.
 *
 * @param p_actor_id        UUID of the admin or service actor performing the action
 * @param p_action          Action name (matches admin_audit_log.action column)
 * @param p_target_user_id  UUID of the user being acted upon
 * @param p_reason          Mandatory reason text — included in the hash key
 * @param p_event_id        Billing event identifier (polar_event_id, polar_refund_id,
 *                          or any unique upstream event reference). Empty/NULL is
 *                          tolerated but degrades to the 054 helper's behaviour.
 * @returns bigint          Existing audit row id if duplicate, NULL otherwise
 *
 * Pre-check SELECT additionally filters audit rows on
 *   after_json->>'polar_event_id' = p_event_id
 * when p_event_id is non-empty, so a hit is only returned if both the lock
 * signature AND the billing event match — preventing false dedup against
 * an unrelated audit row that happens to share the lock key.
 *
 * Security model identical to admin_idempotency_check (migration 054):
 *   - SECURITY DEFINER, SET search_path = public, extensions, pg_temp
 *   - REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO authenticated
 *   - No is_site_admin check (calling wrapper enforces it)
 *
 * SOC2 CC7.2: distinct billing events never collapse into a single audit row.
 * SOC2 CC9.2: financial idempotency keyed on the upstream event id, the
 *   authoritative dedup token for at-least-once webhook delivery.
 * OWASP A04:2021: advisory-lock + targeted SELECT closes the TOCTOU window.
 */
CREATE OR REPLACE FUNCTION public.admin_idempotency_check_with_event(
  p_actor_id        uuid,
  p_action          text,
  p_target_user_id  uuid,
  p_reason          text,
  p_event_id        text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: parity with admin_idempotency_check + every
-- admin_* wrapper. pg_temp last to block search-path injection (OWASP A01:2021).
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_lock_key  bigint;
  v_sig       text;
  v_audit_id  bigint;
  v_event     text := COALESCE(btrim(p_event_id), '');
BEGIN
  -- Build the idempotency signature string. Including the event id means
  -- two refund events with identical (actor, action, target, reason, minute)
  -- but different polar_event_ids hash to DIFFERENT lock keys — they do not
  -- contend on the advisory lock and neither suppresses the other's audit row.
  v_sig := p_actor_id::text
         || '|' || p_action
         || '|' || p_target_user_id::text
         || '|' || btrim(COALESCE(p_reason, ''))
         || '|' || v_event
         || '|' || date_trunc('minute', now())::text;

  -- WHY hashtext()::bigint: hashtext returns int4; pg_advisory_xact_lock(int8)
  -- needs the wider type. No pgcrypto dependency. See migration 054 helper for
  -- full rationale on hash choice.
  v_lock_key := hashtext(v_sig)::bigint;

  -- Acquire the lock. Auto-released at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Pre-check: only return a hit if the audit row is for the SAME event.
  -- WHY filter on after_json->>'polar_event_id': ensures a stale audit row
  -- with the same actor/action/target/reason/minute but a different upstream
  -- event does not falsely suppress a legitimate new event.
  -- When p_event_id is empty we degrade to the same shape as
  -- admin_idempotency_check (no event filter) to keep the helper safe for
  -- non-billing callers who may pass NULL.
  IF v_event = '' THEN
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
  ELSE
    SELECT id INTO v_audit_id
      FROM public.admin_audit_log
      WHERE actor_id         = p_actor_id
        AND action           = p_action
        AND target_user_id   = p_target_user_id
        AND date_trunc('minute', created_at AT TIME ZONE 'UTC')
              = date_trunc('minute', now() AT TIME ZONE 'UTC')
        AND btrim(reason)    = btrim(COALESCE(p_reason, ''))
        AND after_json->>'polar_event_id' = v_event
      ORDER BY id DESC
      LIMIT 1;
  END IF;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_idempotency_check_with_event(uuid, text, uuid, text, text) FROM PUBLIC;
-- WHY authenticated (not service_role): parity with admin_idempotency_check
-- per Phase 4.1 P0 lesson — auth.uid() must resolve in the calling wrapper's
-- SECURITY DEFINER body, which requires the caller to be invoked via a
-- user-scoped JWT.
GRANT EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(uuid, text, uuid, text, text) TO authenticated;


-- ============================================================================
-- §3. SEC-IDEM-001 — admin_issue_refund switches to event-keyed helper
-- ============================================================================

/**
 * admin_issue_refund (migration 056 update)
 *
 * Identical semantics to migration 054's admin_issue_refund EXCEPT the
 * advisory-lock idempotency check now keys on polar_event_id in addition
 * to (actor, action, target, reason, minute). Two distinct refund events
 * with the same reason text in the same minute no longer collapse into a
 * single audit row.
 *
 * Signature, parameters, returns, and grants are unchanged — the
 * rpc-contract-sync test will pass because no parameter is added or removed.
 *
 * @see migration_054 §C.4 for the prior version
 * @see admin_idempotency_check_with_event for the event-keyed helper
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

  -- ── SEC-IDEM-001: event-keyed idempotency check (migration 056) ──────────
  -- Distinct polar_event_ids never collapse, regardless of reason or minute.
  v_existing_audit := public.admin_idempotency_check_with_event(
    v_actor, 'refund_issued', p_target_user_id, p_reason, p_polar_event_id
  );
  IF v_existing_audit IS NOT NULL THEN
    RETURN v_existing_audit;
  END IF;

  -- ── Idempotent INSERT into polar_refund_events (migration 051 logic) ─────
  -- Webhook-replay path: ON CONFLICT (event_id) handles the case where the
  -- first INSERT has already committed. The advisory-lock check above handles
  -- the case where two concurrent requests arrive before the first commits.
  INSERT INTO public.polar_refund_events
    (event_id, refund_id, subscription_id, amount_cents, currency,
     reason, actor_id, target_user_id, processed_at, polar_response_json)
  VALUES
    (p_polar_event_id, p_polar_refund_id, p_polar_subscription_id,
     p_amount_cents, p_currency, p_reason, v_actor, p_target_user_id,
     now(), p_polar_response_json)
  ON CONFLICT (event_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    -- Webhook replay: pre-existing polar_refund_events row. Return its
    -- audit row id (or 0 if none — a row written before this audit pattern
    -- was added would be missing the cross-reference; defensive COALESCE).
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
-- §4. SEC-SM-001 — admin_issue_credit gains idempotency check
-- ============================================================================

/**
 * admin_issue_credit (migration 056 update)
 *
 * Identical semantics to migration 051's admin_issue_credit EXCEPT
 * admin_idempotency_check() is called at the top of the body before any
 * mutation. Two concurrent admin clicks within the same UTC minute on the
 * same target with the same reason now return the SAME (audit_id, credit_id)
 * pair without producing duplicate billing_credits or audit rows.
 *
 * On dedup-hit we recover the original credit_id from the existing audit
 * row's after_json->>'credit_id' so the TABLE return shape is preserved.
 *
 * Signature, parameters, returns, and grants are unchanged.
 *
 * @see migration_051 §3.5.2 for the prior version
 * @see migration_054 header §C documenting why this was originally skipped
 *      (and now corrected — the "billing_credits row is the dedup key"
 *      reasoning is insufficient for the audit-trail integrity requirement).
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_credit_id       bigint;
  v_audit_id        bigint;
  v_existing_audit  bigint;
  v_existing_credit bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ───────────────────────────────────────────────────────
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000 THEN
    RAISE EXCEPTION 'amount_cents must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── SEC-SM-001: idempotency check (migration 056) ────────────────────────
  -- WHY 'credit_issued' action: matches the audit row written below so the
  -- pre-check SELECT in admin_idempotency_check finds the duplicate row.
  -- A double-click on "Issue Credit" is the targeted failure mode: two
  -- concurrent INSERTs would otherwise produce two billing_credits rows
  -- (both unapplied) AND two audit rows. The advisory lock collapses both
  -- requests into a single (audit_id, credit_id) tuple.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'credit_issued', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    -- Recover the credit_id from the original audit row's after_json.
    -- WHY: the TABLE return shape requires us to surface a credit_id even
    -- on dedup-hit. The original admin_issue_credit stored credit_id inside
    -- after_json->>'credit_id' (migration 051 §3.5.2), so it is recoverable.
    SELECT (after_json->>'credit_id')::bigint INTO v_existing_credit
      FROM public.admin_audit_log
      WHERE id = v_existing_audit;

    RETURN QUERY SELECT v_existing_audit, v_existing_credit;
    RETURN;
  END IF;

  -- ── INSERT credit row ──────────────────────────────────────────────────────
  INSERT INTO public.billing_credits
    (user_id, amount_cents, currency, reason, granted_by, granted_at, expires_at)
  VALUES
    (p_target_user_id, p_amount_cents, p_currency, p_reason, v_actor, now(), p_expires_at)
  RETURNING id INTO v_credit_id;

  -- ── Write audit log row ────────────────────────────────────────────────────
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
-- §5. SEC-SM-001 — admin_send_churn_save_offer gains idempotency check
-- ============================================================================

/**
 * admin_send_churn_save_offer (migration 056 update)
 *
 * Identical semantics to migration 051's admin_send_churn_save_offer EXCEPT
 * admin_idempotency_check() is called at the top of the body before any
 * mutation. Two concurrent admin clicks within the same UTC minute on the
 * same (target, kind) tuple with the same reason now return the SAME
 * (audit_id, offer_id) pair without producing a duplicate churn_save_offers
 * row.
 *
 * The pre-existing EXISTS-check duplicate-offer guard (from migration 051)
 * is retained as defense-in-depth. The advisory-lock check fires FIRST on
 * a same-minute double-click; the EXISTS check fires when the second click
 * arrives in a later minute (unlikely double-click pattern, but defensible
 * against multi-tab admin sessions hours apart).
 *
 * Signature, parameters, returns, and grants are unchanged.
 *
 * @see migration_051 §3.5.4 for the prior version
 * @see migration_054 header §C documenting why this was originally skipped
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_discount_pct    int;
  v_duration_months int;
  v_offer_id        bigint;
  v_audit_id        bigint;
  v_existing_audit  bigint;
  v_existing_offer  bigint;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- ── SEC-SM-001: idempotency check (migration 056) ────────────────────────
  -- WHY 'churn_save_sent' action: matches the audit row written below.
  -- WHY before EXISTS guard: the EXISTS guard catches LATER duplicate sends
  -- (different minute) but is racy against truly concurrent INSERTs in the
  -- same minute — both transactions read zero rows from the partial index
  -- before either commits. The advisory lock serialises them so only the
  -- first proceeds and the second exits with the existing audit row.
  v_existing_audit := public.admin_idempotency_check(
    v_actor, 'churn_save_sent', p_target_user_id, p_reason
  );
  IF v_existing_audit IS NOT NULL THEN
    -- Recover offer_id from the original audit row's after_json.
    SELECT (after_json->>'offer_id')::bigint INTO v_existing_offer
      FROM public.admin_audit_log
      WHERE id = v_existing_audit;

    RETURN QUERY SELECT v_existing_audit, v_existing_offer;
    RETURN;
  END IF;

  -- ── Server-side derivation of offer terms from kind ───────────────────────
  IF p_kind = 'annual_3mo_25pct' THEN
    v_discount_pct    := 25;
    v_duration_months := 3;
  ELSIF p_kind = 'monthly_1mo_50pct' THEN
    v_discount_pct    := 50;
    v_duration_months := 1;
  ELSE
    RAISE EXCEPTION 'unhandled churn_offer_kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  -- ── Duplicate-offer guard (migration 051 §3.5.4) — defense-in-depth ──────
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

  -- ── INSERT offer row ───────────────────────────────────────────────────────
  INSERT INTO public.churn_save_offers
    (user_id, kind, discount_pct, discount_duration_months,
     sent_by, sent_at, expires_at, polar_discount_code, reason)
  VALUES
    (p_target_user_id, p_kind, v_discount_pct, v_duration_months,
     v_actor, now(), now() + interval '7 days', p_polar_discount_code, p_reason)
  RETURNING id INTO v_offer_id;

  -- ── Write audit log row ────────────────────────────────────────────────────
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor,
     p_target_user_id,
     'churn_save_sent',
     'churn_save_offers',
     NULL,
     jsonb_build_object(
       'offer_id',                v_offer_id,
       'kind',                    p_kind,
       'discount_pct',            v_discount_pct,
       'discount_duration_months', v_duration_months,
       'expires_at',              now() + interval '7 days'
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN QUERY SELECT v_audit_id, v_offer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_churn_save_offer(uuid, public.churn_offer_kind, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_send_churn_save_offer(uuid, public.churn_offer_kind, text, text) TO authenticated;


-- ============================================================================
-- Migration 056 complete.
--
-- CHANGES APPLIED:
--   §1 Triggers:
--     audit_log_billing_credits        ON public.billing_credits
--     audit_log_churn_save_offers      ON public.churn_save_offers
--     audit_log_support_access_grants  ON public.support_access_grants
--
--   §2 New helper:
--     public.admin_idempotency_check_with_event(uuid, text, uuid, text, text) → bigint
--
--   §3 admin_issue_refund — switched to event-keyed idempotency
--   §4 admin_issue_credit — added admin_idempotency_check
--   §5 admin_send_churn_save_offer — added admin_idempotency_check
--
-- VERIFICATION:
--   - rpc-contract-sync test (packages/styrby-web/src/__tests__/security):
--     no signatures changed; existing call sites continue to pass.
--   - CI db-reset twice: triggers DROP-IF-EXISTS-then-CREATE is idempotent;
--     functions are CREATE OR REPLACE.
-- ============================================================================
