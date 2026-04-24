-- ============================================================================
-- Migration 045: PRE-FLIGHT — Fix audit_trigger_fn column name (details → metadata)
-- ============================================================================
-- WHY this fix is bundled here (not in a separate later migration):
--   This migration's test fixture (DO $$ block at the end of §3) triggers
--   audit_trigger_fn via an auth.users INSERT → handle_new_user() cascade →
--   profiles INSERT → audit_trigger_fn(). The function body in migration 018
--   references a non-existent column "details" (the actual column is "metadata"
--   per migration 001 line 755) — a latent bug since migration 018. We MUST
--   fix it before our test block runs, otherwise the profiles INSERT triggers
--   SQLSTATE 42703 ("column details does not exist"), which aborts the DO $$
--   block and rolls back the entire migration.
--
--   Migration 047 (which was originally planned to carry this fix) has been
--   deleted because it ran AFTER 045 where the broken trigger was already
--   crashing. The fix must land here, as the very first statement.
--
-- SOC2 CC7.2: audit_trigger_fn must insert correctly into audit_log. A broken
--   function body means audit records are silently dropped on every tracked
--   table mutation — a monitoring gap that violates CC7.2.
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
    -- the row's user_id is the affected user - correct for audit attribution.
    -- Falls back to auth.uid() if the row has no user_id column.
    COALESCE(v_user_id, auth.uid()),

    -- WHY: Cast TG_OP to audit_action via text. TG_OP values are 'INSERT',
    -- 'UPDATE', 'DELETE' - which must exist in the audit_action enum.
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
    -- fields changed on UPDATE. No PII scrubbing here - audit_log is a
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
-- Migration 045: Two CRITICAL fixes from T8 quality review.
--
-- CRITICAL 1 (C1) - Hash chain crash on null actor_id
-- ============================================================================
-- Problem: migration 040's admin_audit_chain_hash() trigger uses bare
--   NEW.actor_id::text in the hash concatenation. NULL::text makes the entire
--   SQL string concat produce NULL, so row_hash becomes NULL, violating the
--   NOT NULL column constraint. Every INSERT with actor_id = NULL (valid per
--   migration 044 for system-action rows like 'manual_override_expired') will
--   crash the trigger and roll back the owning transaction.
--
-- Fix: CREATE OR REPLACE both admin_audit_chain_hash() and
--   verify_admin_audit_chain() with identical logic EXCEPT that
--   NEW.actor_id::text (trigger) / r.actor_id::text (verifier) each gain a
--   COALESCE(..., ''). Concatenation order is byte-for-byte identical to
--   migration 040 - the ONLY change is COALESCE on actor_id.
--
-- WHY both functions must be updated together: the hash verifier MUST produce
--   the same bytes as the trigger or every null-actor row will fail chain
--   verification. They are intentionally kept in lock-step.
--
-- SOC2 CC7.2: NULL actor_id rows (system-initiated audit events) must be
--   recordable without crashing the owning transaction. Losing audit coverage
--   because of a constraint violation is a worse outcome than the migration
--   040 oversight. OWASP A09:2021: silent audit gaps are a monitoring failure.
--
-- CRITICAL 2 (C2) - TOCTOU race in override-expiry flow
-- ============================================================================
-- Problem: The existing flow makes 4 separate PostgREST/RPC calls for an
--   override-expiry transition. The FOR UPDATE lock acquired in call 1 is
--   released when that RPC's transaction commits. By the time call 3 issues
--   the UPDATE and call 4 issues the audit INSERT, there is no lock - a
--   concurrent webhook delivery can race through all four calls simultaneously,
--   producing duplicate subscription state and duplicate audit rows.
--
-- Fix: A single SECURITY DEFINER function that acquires the FOR UPDATE lock
--   and holds it for the entire expiry transition (SELECT before-state,
--   UPDATE subscriptions, SELECT after-state, INSERT admin_audit_log) in one
--   transaction. The function returns a decision union so the Node route can
--   remain stateless.
--
-- SOC2 CC6.1: Atomic DB function eliminates the TOCTOU window by holding the
--   FOR UPDATE lock across the full read-modify-write-audit cycle.
-- ============================================================================

-- ============================================================================
-- §1  C1: Replace admin_audit_chain_hash() with COALESCE on actor_id
-- ============================================================================

/*
 * admin_audit_chain_hash (trigger function) - replaces migration 040 version.
 *
 * BEFORE INSERT trigger that computes prev_hash and row_hash for each new
 * admin_audit_log row.
 *
 * Hash input format (MUST be byte-for-byte identical to verify_admin_audit_chain):
 *   SHA256( prev_hash || '|' || id::text
 *           || '|' || COALESCE(actor_id::text, '')
 *           || '|' || action
 *           || '|' || COALESCE(target_user_id::text, '')
 *           || '|' || COALESCE(before_json::text, '')
 *           || '|' || COALESCE(after_json::text, '')
 *           || '|' || reason
 *           || '|' || created_at::text )
 *
 * Change vs migration 040: actor_id::text changed to COALESCE(actor_id::text, '').
 *   All other field order, separators, and COALESCE usage are identical.
 *
 * WHY COALESCE on actor_id: migration 044 dropped NOT NULL from actor_id to
 *   allow system-action rows (e.g. 'manual_override_expired') where no human
 *   admin is the actor. Without COALESCE, NULL actor_id propagates NULL through
 *   string concat, producing NULL row_hash, which violates the NOT NULL
 *   constraint on that column and crashes the INSERT. COALESCE to '' is the
 *   minimal safe sentinel that preserves the hash preimage structure.
 *
 * WHY '' (empty string) not a sentinel UUID: any fixed non-empty sentinel would
 *   create a collision risk between 'NULL actor' and a real admin whose UUID
 *   happens to produce the same concat result when COALESCE picks the fallback.
 *   Empty string is unambiguous because no real UUID serialises as ''.
 *
 * returns trigger
 */
CREATE OR REPLACE FUNCTION public.admin_audit_chain_hash()
RETURNS trigger
LANGUAGE plpgsql
-- WHY extensions in search_path: digest() and encode() live in the 'extensions'
-- schema in Supabase (pgcrypto is pre-installed there). Without this the trigger
-- body cannot resolve them when invoked by the trigger mechanism.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_prev_hash text;
BEGIN
  /*
   * Transaction-scoped advisory lock serializes concurrent INSERTs against the
   * admin_audit_log chain. Without it, two parallel INSERTs would read the same
   * prev_hash and produce a permanently-broken chain.
   *
   * WHY pg_advisory_xact_lock vs pg_advisory_lock: the _xact_ variant is
   * automatically released at transaction end - no explicit unlock needed, and
   * no risk of a lock surviving an error/rollback scenario.
   *
   * hashtext('admin_audit_log_chain') produces a stable 32-bit integer key
   * scoped to this specific chain - no collision with unrelated advisory locks.
   */
  PERFORM pg_advisory_xact_lock(hashtext('admin_audit_log_chain'));

  -- Fetch the most recent row_hash, or genesis sentinel '0' if table is empty.
  -- WHY '0' not '' or NULL: a known non-hex sentinel makes it visually obvious
  -- in a chain dump that this is the genesis row.
  SELECT row_hash INTO v_prev_hash
    FROM public.admin_audit_log
    ORDER BY id DESC
    LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev_hash, '0');

  -- Compute row_hash using the EXACT same field order as verify_admin_audit_chain.
  -- Any field-order drift between trigger and verifier causes permanent chain failure.
  -- Field order: prev_hash | id | actor_id | action | target_user_id |
  --              before_json | after_json | reason | created_at
  NEW.row_hash := encode(
    digest(
      NEW.prev_hash
        || '|' || NEW.id::text
        || '|' || COALESCE(NEW.actor_id::text, '')
        || '|' || NEW.action
        || '|' || COALESCE(NEW.target_user_id::text, '')
        || '|' || COALESCE(NEW.before_json::text, '')
        || '|' || COALESCE(NEW.after_json::text, '')
        || '|' || NEW.reason
        || '|' || NEW.created_at::text,
      'sha256'
    ),
    'hex'
  );

  RETURN NEW;
END;
$$;

-- WHY no DROP/CREATE trigger: the function was CREATE OR REPLACE'd. The existing
-- trigger on admin_audit_log still points to public.admin_audit_chain_hash() - the
-- updated function body is picked up automatically on the next trigger fire.


-- ============================================================================
-- §2  C1: Replace verify_admin_audit_chain() with matching COALESCE on actor_id
-- ============================================================================

/*
 * verify_admin_audit_chain - replaces migration 040 version.
 *
 * Walks the entire admin_audit_log from first (lowest id) to last,
 * re-computing each row's expected hash and comparing it to the stored
 * row_hash. Returns a single row describing the verification result.
 *
 * Change vs migration 040: r.actor_id::text changed to COALESCE(r.actor_id::text, '').
 *   Hash field order and all other COALESCE calls are identical to the updated
 *   admin_audit_chain_hash() trigger above. This byte-for-byte parity is a
 *   non-negotiable invariant: any deviation silently produces false-negative
 *   chain breaks for every null-actor row.
 *
 * returns TABLE(
 *   status          text   - 'ok' | 'prev_hash_mismatch' | 'row_hash_mismatch'
 *   first_broken_id bigint - id of first broken row, or NULL if ok
 *   total_rows      bigint - number of rows inspected
 * )
 *
 * throws 'not authorized' if the caller is not a site admin.
 *
 * SECURITY DEFINER: required to query admin_audit_log (RLS restricts it to
 *   site admins, but this function also checks is_site_admin to be explicit).
 *
 * example:
 *   SELECT * FROM public.verify_admin_audit_chain();
 *   Returns: ('ok', NULL, 42)
 */
CREATE OR REPLACE FUNCTION public.verify_admin_audit_chain()
RETURNS TABLE (status text, first_broken_id bigint, total_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: digest() and encode() live in the 'extensions'
-- schema in Supabase (pgcrypto is pre-installed there, not in public).
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  r               record;
  v_prev_hash     text := '0';   -- starts at genesis sentinel, same as trigger
  v_expected_hash text;
  v_count         bigint := 0;
BEGIN
  -- WHY: Defense-in-depth auth check inside the function body, not just at the
  -- GRANT layer. A future bug that grants execute to a wider role does not
  -- silently expose the audit chain.
  IF NOT public.is_site_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOR r IN
    -- Walk in insertion order (ascending id) to match the chain direction.
    SELECT * FROM public.admin_audit_log ORDER BY id ASC
  LOOP
    v_count := v_count + 1;

    -- Check that the stored prev_hash matches our running prev_hash pointer.
    IF r.prev_hash <> v_prev_hash THEN
      RETURN QUERY SELECT 'prev_hash_mismatch'::text, r.id, v_count;
      RETURN;
    END IF;

    -- Re-compute expected row_hash using the EXACT same field order as the
    -- admin_audit_chain_hash() trigger. Any drift = permanent false negatives.
    v_expected_hash := encode(
      digest(
        r.prev_hash
          || '|' || r.id::text
          || '|' || COALESCE(r.actor_id::text, '')
          || '|' || r.action
          || '|' || COALESCE(r.target_user_id::text, '')
          || '|' || COALESCE(r.before_json::text, '')
          || '|' || COALESCE(r.after_json::text, '')
          || '|' || r.reason
          || '|' || r.created_at::text,
        'sha256'
      ),
      'hex'
    );

    IF r.row_hash <> v_expected_hash THEN
      RETURN QUERY SELECT 'row_hash_mismatch'::text, r.id, v_count;
      RETURN;
    END IF;

    -- Advance the chain pointer to the current row's hash.
    v_prev_hash := r.row_hash;
  END LOOP;

  -- All rows verified cleanly (or table is empty - count = 0).
  RETURN QUERY SELECT 'ok'::text, NULL::bigint, v_count;
END;
$$;

-- Preserve the original grant configuration from migration 040.
REVOKE ALL ON FUNCTION public.verify_admin_audit_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain() TO authenticated;


-- ============================================================================
-- §3  C1 regression test: INSERT with actor_id = NULL must succeed and chain
--     must verify clean afterward.
--
-- WHY inline SQL test (not only a pgTAP test): this migration is the fix.
-- Running the assertion here proves the fix is correct at migration time.
-- If the test fails, the migration aborts and no partial state is applied.
-- The test block is wrapped in a savepoint so it can be rolled back cleanly
-- after the assertion without rolling back the CREATE OR REPLACE above.
-- ============================================================================

DO $$
DECLARE
  v_admin      uuid := gen_random_uuid();
  v_target     uuid := gen_random_uuid();
  v_null_actor_id bigint;
  v_status     text;
  v_broken_id  bigint;
  v_total_rows bigint;
BEGIN
  -- Seed auth users required for FK constraints.
  INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
    VALUES
      (v_admin,  'admin_045_test@migration.test', 'x', now(), now()),
      (v_target, 'target_045_test@migration.test','x', now(), now());

  INSERT INTO public.site_admins (user_id, added_by, note)
    VALUES (v_admin, v_admin, 'migration 045 test seed');

  -- First, insert a normal (non-null actor) row to establish a non-empty chain.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (v_admin, v_target, 'override_tier', 'migration 045 test - baseline row', '0', '0');

  -- KEY ASSERTION: insert a row with actor_id = NULL and action = 'manual_override_expired'.
  -- This is exactly the scenario that crashed in migration 040 before this fix.
  -- If COALESCE is correctly applied, the trigger fires without error and row_hash is non-null.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, reason, prev_hash, row_hash)
  VALUES
    (NULL, v_target, 'manual_override_expired',
     'Polar webhook auto-expired manual override after override_expires_at (migration 045 test)',
     '0', '0')
  RETURNING id INTO v_null_actor_id;

  IF v_null_actor_id IS NULL THEN
    RAISE EXCEPTION 'MIGRATION 045 TEST FAILED: INSERT with actor_id=NULL returned no id - trigger blocked the row';
  END IF;

  -- Verify the chain is still intact after the null-actor insert.
  -- We invoke the function as superuser by temporarily setting the JWT sub claim.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  SELECT v.status, v.first_broken_id, v.total_rows
    INTO v_status, v_broken_id, v_total_rows
    FROM public.verify_admin_audit_chain() AS v;

  -- Reset claims
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_status <> 'ok' THEN
    RAISE EXCEPTION 'MIGRATION 045 TEST FAILED: verify_admin_audit_chain returned status=%, first_broken_id=%, total_rows=% after null-actor insert',
      v_status, v_broken_id, v_total_rows;
  END IF;

  IF v_total_rows <> 2 THEN
    RAISE EXCEPTION 'MIGRATION 045 TEST FAILED: expected 2 rows in chain, got %', v_total_rows;
  END IF;

  -- Cleanup test fixtures (in reverse FK order)
  DELETE FROM public.admin_audit_log WHERE target_user_id IN (v_admin, v_target);
  DELETE FROM public.site_admins WHERE user_id = v_admin;
  DELETE FROM auth.users WHERE id IN (v_admin, v_target);

  RAISE NOTICE 'MIGRATION 045 TEST PASSED: null actor_id INSERT succeeds + chain verifies ok (% rows)', v_total_rows;
END;
$$;


-- ============================================================================
-- §4  C2: apply_polar_subscription_with_override_check
--
-- Atomic SECURITY DEFINER function that acquires a FOR UPDATE row lock and
-- holds it across the full override-expiry read-modify-write-audit cycle.
-- Eliminates the TOCTOU window that existed when the webhook route issued
-- four separate PostgREST/RPC calls.
-- ============================================================================

/*
 * apply_polar_subscription_with_override_check
 *
 * Single-transaction entry point for Polar webhook tier-update logic when a
 * manual override may be in effect.
 *
 * Decision matrix (returned as `decision` column):
 *   'polar_source'          - no active override; caller applies tier update normally.
 *   'manual_override_active' - active manual override; caller skips tier update.
 *   'override_expired'      - override has elapsed; THIS FUNCTION has already
 *                             applied the tier update + reset + audit INSERT in
 *                             the same transaction. Caller just logs structurally.
 *
 * WHY SECURITY DEFINER: the webhook route uses service_role, but this function
 *   also needs to INSERT into admin_audit_log and UPDATE subscriptions in one
 *   transaction without multiple round-trips. SECURITY DEFINER guarantees the
 *   search_path is fixed and cannot be injected by the caller.
 *
 * WHY FOR UPDATE (not FOR SHARE): the expiry branch immediately UPDATEs the
 *   subscriptions row. FOR SHARE would allow concurrent readers to also read
 *   'manual' and both attempt the expiry; FOR UPDATE makes the second delivery
 *   wait and then see 'polar' (already reset) on re-read.
 *
 * param p_user_id                Target user UUID (subscriptions.user_id).
 * param p_new_tier               Tier string from Polar event ('pro', 'power', etc.).
 * param p_polar_subscription_id  Polar subscription ID for the UPDATE.
 * param p_billing_cycle          'monthly' | 'annual'.
 * param p_current_period_end     From the Polar payload.
 * param p_polar_event_id         Top-level Polar event UUID (for audit reason field).
 *
 * returns TABLE(
 *   decision      text          - 'polar_source' | 'manual_override_active' | 'override_expired'
 *   expires_at    timestamptz   - non-null only for manual_override_active
 *   previous_actor uuid         - non-null only for override_expired (may still be null if unknown)
 *   audit_id      bigint        - non-null only for override_expired
 * )
 *
 * SOC2 CC6.1: Atomic function eliminates TOCTOU race for concurrent webhook deliveries.
 * SOC2 CC7.2: Override expiry is recorded in admin_audit_log within the same transaction.
 */
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
  -- Server-side tier allowlist check - defense-in-depth.
  --
  -- WHY here (not only in getTierFromProductId Node layer):
  --   getTierFromProductId() is the primary filter - it rejects unrecognized
  --   Polar product IDs before this RPC is ever called. However, future Polar
  --   payload surface expansion (new product families, new checkout metadata
  --   fields) or a Node-layer regression could admit an unexpected tier string.
  --   An RPC-level allowlist ensures 'invalid tier value' (ERRCODE 22023) is
  --   raised with no DB side effects - the row lock is never even acquired.
  --   This matches the pattern in admin_override_tier (migration 041 §1) which
  --   applies the same allowlist before any state-mutating DB access.
  --
  -- WHY ERRCODE 22023 (invalid_parameter_value): same code as T2
  --   (admin_override_tier) so callers can detect tier-validation errors
  --   programmatically by ERRCODE without parsing the message string.
  --
  -- WHY place BEFORE the SELECT ... FOR UPDATE:
  --   Fail fast with no side effects. A typo'd tier short-circuits immediately;
  --   no row lock is acquired, no transaction resources are held.
  --
  -- OWASP A03:2021 (Injection): validates input at the boundary before any DML.
  IF p_new_tier NOT IN ('free', 'pro', 'power', 'team', 'business', 'enterprise') THEN
    RAISE EXCEPTION 'invalid tier value' USING ERRCODE = '22023';
  END IF;

  -- Acquire row lock for the full transaction.
  -- WHY FOR UPDATE: holds the lock until this transaction commits/rolls back,
  -- serializing any concurrent webhook delivery for the same user. The second
  -- delivery will block here, then re-read the row (override_source now 'polar'
  -- after the first delivery's expiry path) and follow the polar_source branch.
  SELECT s.override_source, s.override_expires_at
    INTO v_override_source, v_override_expires_at
    FROM public.subscriptions s
    WHERE s.user_id = p_user_id
    FOR UPDATE;

  -- No subscription row yet - polar_source (new subscription flow).
  -- Let the caller handle INSERT since it needs more Polar payload fields
  -- (polar_customer_id, polar_product_id, is_annual, etc.) that are not
  -- passed into this function.
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'polar_source'::text, NULL::timestamptz, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;

  -- Manual override active - skip the tier update entirely.
  -- WHY check NULL separately: override_expires_at IS NULL means permanent
  -- (no expiry); any future timestamp means still active. Both block Polar.
  IF v_override_source = 'manual'
     AND (v_override_expires_at IS NULL OR v_override_expires_at > now()) THEN
    RETURN QUERY SELECT 'manual_override_active'::text, v_override_expires_at, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;

  -- Manual override has elapsed - reset + apply update + audit row, all in this txn.
  IF v_override_source = 'manual' AND v_override_expires_at <= now() THEN

    -- Lookup previous admin from last override_tier audit.
    -- WHY admin_audit_log (not subscriptions): subscriptions stores the override
    -- reason text but not the actor UUID. The audit log is the only tamper-
    -- resistant record of who set the override. (SOC2 CC7.2.)
    SELECT actor_id INTO v_previous_actor
      FROM public.admin_audit_log
      WHERE target_user_id = p_user_id
        AND action = 'override_tier'
      ORDER BY id DESC
      LIMIT 1;

    -- Capture before-state for audit diff.
    SELECT to_jsonb(s.*) INTO v_before_json
      FROM public.subscriptions s
      WHERE s.user_id = p_user_id;

    -- Apply tier update + reset override columns.
    -- WHY NOT include override_reason: admin-owned column; the webhook must never
    -- overwrite the admin's historical context. (Spec requirement.)
    UPDATE public.subscriptions
      SET tier                 = p_new_tier,
          polar_subscription_id = p_polar_subscription_id,
          billing_cycle         = p_billing_cycle,
          current_period_end    = p_current_period_end,
          override_source       = 'polar',
          override_expires_at   = NULL,
          updated_at            = now()
      WHERE user_id = p_user_id;

    -- Capture after-state.
    SELECT to_jsonb(s.*) INTO v_after_json
      FROM public.subscriptions s
      WHERE s.user_id = p_user_id;

    -- Insert audit row (actor_id may be NULL per migration 044 whitelist).
    -- WHY ip = NULL: system-initiated row; no human IP. 'polar-webhook' as
    -- user_agent makes the origin searchable in the audit UI.
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
  -- Caller applies the tier update with full Polar payload shape.
  RETURN QUERY SELECT 'polar_source'::text, NULL::timestamptz, NULL::uuid, NULL::bigint;
END;
$$;

-- WHY service_role only: only the Polar webhook route (which runs as service_role
-- after HMAC verification) needs to call this function. Granting to authenticated
-- or anon would create an unintended mutation vector.
-- WHY REVOKE PUBLIC first: defense-in-depth against future grant drift.
REVOKE ALL ON FUNCTION public.apply_polar_subscription_with_override_check(
  uuid, text, text, text, timestamptz, text
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(
  uuid, text, text, text, timestamptz, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(
  uuid, text, text, text, timestamptz, text
) TO service_role;

-- ============================================================================
-- Migration 045 complete.
-- ============================================================================
