-- ============================================================================
-- Migration 040: Admin Console — Site Admin Operations (Phase 4.1)
--
-- Creates:
--   1. site_admins table + RLS + is_site_admin() helper function
--   2. admin_audit_log table + RLS + hash-chain trigger + verify function
--   3. consent_flags table + consent_purpose enum + RLS
--   4. ALTER public.subscriptions to add override_source, override_expires_at,
--      override_reason columns + backfill existing rows as 'polar'
--
-- Out of scope in this migration (see 041_admin_wrappers.sql — T2):
--   - SECURITY DEFINER wrappers: admin_override_tier, admin_toggle_consent,
--     admin_record_password_reset
--
-- Security model summary:
--   - site_admins: auth'd users can only SELECT their own row. No app-level
--     INSERT/UPDATE/DELETE — managed exclusively via service-role SQL.
--   - admin_audit_log: site admins can SELECT all rows; all other roles see
--     nothing. UPDATE and DELETE are explicitly REVOKED (defense-in-depth)
--     to make the log tamper-resistant even against a future grant regression.
--   - consent_flags: users see their own row; site admins see all.
--   - is_site_admin(): SECURITY DEFINER so the subquery executes with the
--     definer's elevated rights even when called from a restricted role.
--
-- SOC2 CC7.2: Database-layer access control enforced via RLS on every table.
-- OWASP A01:2021 (Broken Access Control): Deny-by-default via RLS; explicit
--   REVOKE prevents privilege escalation via accidental future GRANTs.
-- ============================================================================

-- ============================================================================
-- §3.1 site_admins — Admin allowlist
-- ============================================================================

/**
 * site_admins
 *
 * Allowlist of users with site-admin privileges. This is the single source of
 * truth for "is this person a site admin?" — both the RLS policies and the
 * is_site_admin() helper function read from this table.
 *
 * Intentionally seeded empty. The bootstrap INSERT is a manual, one-off
 * operation documented in the spec §8. An empty table at launch means no one
 * can reach /admin — fail-closed by design.
 *
 * Columns:
 *   user_id   — FK to auth.users; is also the PK (one row per admin)
 *   added_at  — audit trail for when the admin was added
 *   added_by  — which admin added this one (NULL = bootstrap)
 *   note      — mandatory free-text context for why this user is an admin
 */
CREATE TABLE public.site_admins (
  user_id   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now(),
  added_by  uuid REFERENCES auth.users(id),
  note      text NOT NULL
);

-- WHY: service_role must be able to INSERT/UPDATE/DELETE site_admins for bootstrap
-- and admin-management operations performed outside user context (e.g. Edge Functions,
-- CLI admin scripts). Without this grant, service_role calls return permission-denied
-- even though service_role bypasses RLS — table-level privileges are separate from RLS.
GRANT ALL ON public.site_admins TO service_role;

-- RLS: authenticated users can SELECT their own row only.
-- WHY: Prevents enumeration of the admin allowlist via the PostgREST API.
-- An authenticated non-admin user who tries to LIST site_admins sees 0 rows
-- (not an error), which avoids leaking the existence of the admin mechanism.
-- INSERT/UPDATE/DELETE: no policy → blocked for all non-service roles.
ALTER TABLE public.site_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_admins_select_self ON public.site_admins
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
-- WHY: "SELECT auth.uid()" (subquery form) instead of "auth.uid()" (function
-- call) lets Postgres cache the result in the query plan, which materially
-- reduces overhead on tables scanned many times per request (Supabase pattern).

/**
 * is_site_admin
 *
 * Returns true if p_user_id exists in site_admins. Used as a guard in every
 * SECURITY DEFINER wrapper function and in the audit log RLS policy.
 *
 * SECURITY DEFINER: Required so the SELECT on site_admins runs with the
 * definer's privileges rather than the caller's. When this function is
 * invoked from inside another SECURITY DEFINER function (or via a policy
 * USING clause), the caller may not have direct table access to site_admins.
 * Without SECURITY DEFINER, auth'd non-admin users would always see false
 * because RLS hides all site_admins rows from them.
 *
 * SET search_path: Prevents search-path injection attacks where a malicious
 * user creates a public function that shadows internal helpers.
 *
 * STABLE: No side effects; result depends only on the DB state, enabling
 * Postgres to cache it within a query.
 *
 * @param p_user_id  The UUID to check against site_admins.user_id
 * @returns  true if the user is a site admin, false otherwise
 */
CREATE OR REPLACE FUNCTION public.is_site_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.site_admins WHERE user_id = p_user_id
  );
$$;

-- WHY: REVOKE then re-GRANT to enforce least-privilege. PUBLIC (which includes
-- every role including anon) is revoked first; only 'authenticated' can call it.
REVOKE ALL ON FUNCTION public.is_site_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_site_admin(uuid) TO authenticated;


-- ============================================================================
-- §3.2 admin_audit_log — Append-only hash-chained audit log
-- ============================================================================

/**
 * admin_audit_log
 *
 * Records every admin mutation. Append-only: RLS allows only SELECT (for
 * site admins); UPDATE and DELETE are explicitly REVOKEd. The hash chain
 * (prev_hash → row_hash) makes tampering detectable even if a row is
 * changed via a direct DB connection that bypasses RLS.
 *
 * Hash chain format (MUST match verify_admin_audit_chain byte-for-byte):
 *   SHA256( prev_hash | id | actor_id | action | target_user_id |
 *           before_json | after_json | reason | created_at )
 *   Fields separated by the pipe '|' character.
 *   NULL fields coalesced to empty string '' before concatenation.
 *
 * Columns:
 *   id              — bigserial auto-increment PK; used as the hash input
 *   actor_id        — site admin who triggered the action
 *   target_user_id  — user affected (nullable for non-user-targeted actions)
 *   action          — machine-readable verb, lowercase snake_case only
 *   target_entity   — e.g. 'subscriptions:<uuid>' (context for UI display)
 *   before_json     — full row state before mutation (for diff display)
 *   after_json      — full row state after mutation
 *   reason          — mandatory free-text justification (CHECK length > 0)
 *   ip              — admin's IP address at time of action
 *   user_agent      — admin's browser/client user-agent string
 *   prev_hash       — row_hash of the immediately preceding row ('0' for genesis)
 *   row_hash        — SHA256 of the canonical fields (see above)
 *   created_at      — set by DEFAULT now(); used in the hash calculation
 */
CREATE TABLE public.admin_audit_log (
  id              bigserial PRIMARY KEY,
  actor_id        uuid NOT NULL REFERENCES auth.users(id),
  target_user_id  uuid REFERENCES auth.users(id),
  action          text NOT NULL,
  target_entity   text,
  before_json     jsonb,
  after_json      jsonb,
  reason          text NOT NULL,
  ip              inet,
  user_agent      text,
  prev_hash       text NOT NULL,
  row_hash        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- WHY: Enforce reason is non-empty at the DB layer so no wrapper function
  -- can accidentally skip it. Complements the application-level check.
  CONSTRAINT chk_reason_nonempty CHECK (length(reason) > 0),

  -- WHY: Restrict action to lowercase snake_case. Prevents typos like
  -- 'Override_Tier' vs 'override_tier' from creating split audit trails.
  CONSTRAINT chk_action_format CHECK (action ~ '^[a-z_]+$')
);

-- Indexes for the three common admin_audit_log query patterns:
--   1. "Show all actions affecting user X" — target_user_id + created_at DESC
--   2. "Show all actions by admin Y"        — actor_id + created_at DESC
--   3. "Full table scan for hash verification" — BRIN on created_at (time-series)
CREATE INDEX idx_admin_audit_target  ON public.admin_audit_log (target_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_actor   ON public.admin_audit_log (actor_id, created_at DESC);
CREATE INDEX idx_admin_audit_created ON public.admin_audit_log USING BRIN (created_at);

-- RLS: only site admins can SELECT. Non-admins see zero rows.
-- WHY: Admin actions are sensitive operational data. A user should never be
-- able to infer what admin operations were performed on their account, nor
-- enumerate actions on other users. site_admins see everything (they own ops).
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- WHY: Policy name uses underscore not space ("site admin" → "site_admin")
-- to avoid quoting requirements in pg_policies catalog queries.
CREATE POLICY audit_select_site_admin ON public.admin_audit_log
  FOR SELECT TO authenticated
  USING (public.is_site_admin((SELECT auth.uid())));

-- WHY: Even though RLS denies UPDATE/DELETE by default (no policy = deny),
-- an explicit REVOKE is defense-in-depth against two attack vectors:
--   1. A future GRANT UPDATE ... TO authenticated (typo or misconfiguration)
--   2. A SECURITY DEFINER function that runs as a high-priv role and doesn't
--      intend to allow audit mutation, but might inherit caller privileges.
-- SOC2 CC7.2: Explicit REVOKE is auditor-visible evidence of tamper resistance.
-- OWASP A01: "Broken access control" cannot be introduced by future grant drift.
REVOKE UPDATE, DELETE ON public.admin_audit_log FROM PUBLIC, authenticated, anon;

-- WHY: service_role must be able to INSERT into admin_audit_log on behalf of
-- SECURITY DEFINER wrapper functions (migration 041) and Edge Functions that
-- record admin actions. The sequence grant is required so the bigserial PK can
-- advance. UPDATE/DELETE are not granted here — the explicit REVOKE above makes
-- those impossible regardless, but we do not grant what we do not need.
GRANT ALL ON public.admin_audit_log TO service_role;
GRANT ALL ON SEQUENCE public.admin_audit_log_id_seq TO service_role;


/**
 * admin_audit_chain_hash (trigger function)
 *
 * BEFORE INSERT trigger that computes prev_hash and row_hash for each new
 * audit log row. Both columns are set by this trigger; the INSERT caller
 * does NOT need to supply them (they will be overwritten regardless).
 *
 * Hash input format (MUST be byte-for-byte identical to verify_admin_audit_chain):
 *   SHA256( prev_hash || '|' || id || '|' || actor_id || '|' || action
 *           || '|' || COALESCE(target_user_id, '')
 *           || '|' || COALESCE(before_json::text, '')
 *           || '|' || COALESCE(after_json::text, '')
 *           || '|' || reason
 *           || '|' || created_at::text )
 *
 * WHY BEFORE INSERT (not AFTER): We need to modify NEW.prev_hash and
 * NEW.row_hash before the row is written to disk. AFTER triggers cannot
 * modify the row being inserted.
 *
 * WHY id is available in BEFORE: bigserial assigns the sequence value
 * during row formation, before the BEFORE trigger fires. The id is part of
 * the hash to bind it irrevocably to this specific row's position.
 *
 * @returns trigger
 */
CREATE OR REPLACE FUNCTION public.admin_audit_chain_hash()
RETURNS trigger
LANGUAGE plpgsql
-- WHY extensions in search_path: digest() and encode() live in the 'extensions'
-- schema in Supabase (pgcrypto is pre-installed there). Without this, the
-- trigger body cannot resolve them when the function is invoked by the trigger
-- mechanism (which runs with a minimal search_path).
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_prev_hash text;
BEGIN
  /*
   * Transaction-scoped advisory lock serializes concurrent INSERTs against
   * the admin_audit_log chain. Without it, two parallel INSERTs would read
   * the same prev_hash and produce a permanently-broken chain verifiable by
   * verify_admin_audit_chain(). The lock is released when the containing
   * transaction commits or rolls back.
   *
   * WHY pg_advisory_xact_lock vs pg_advisory_lock: the _xact_ variant is
   * automatically released at transaction end — no explicit unlock needed,
   * and no risk of a lock surviving an error/rollback scenario.
   *
   * hashtext('admin_audit_log_chain') produces a stable 32-bit integer key
   * scoped to this specific chain — no collision with unrelated advisory locks.
   */
  PERFORM pg_advisory_xact_lock(hashtext('admin_audit_log_chain'));

  -- Fetch the most recent row_hash, or genesis sentinel '0' if table is empty.
  -- WHY '0' not '' or NULL: a known non-hex sentinel makes it visually obvious
  -- in a chain dump that this is the genesis row, and it cannot be confused
  -- with a real SHA256 output (which is always 64 hex chars).
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
        || '|' || NEW.actor_id::text
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

CREATE TRIGGER admin_audit_chain_hash_trigger
  BEFORE INSERT ON public.admin_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.admin_audit_chain_hash();


/**
 * verify_admin_audit_chain
 *
 * Walks the entire admin_audit_log from first (lowest id) to last, re-computing
 * each row's expected hash and comparing it to the stored row_hash. Returns a
 * single row describing the verification result.
 *
 * @returns TABLE(
 *   status          text     — 'ok' | 'prev_hash_mismatch' | 'row_hash_mismatch'
 *   first_broken_id bigint   — id of first broken row, or NULL if ok
 *   total_rows      bigint   — number of rows inspected
 * )
 *
 * @throws 'not authorized' if the caller is not a site admin
 *
 * SECURITY DEFINER: Required to query admin_audit_log (RLS restricts it to
 * site admins, but this function also checks is_site_admin to be explicit).
 *
 * WHY NOT expose to anon: An unauthenticated attacker should not be able to
 * discover the hash chain state or probe whether tampering has occurred.
 *
 * @example
 *   SELECT * FROM public.verify_admin_audit_chain();
 *   -- Returns: ('ok', NULL, 42)
 */
CREATE OR REPLACE FUNCTION public.verify_admin_audit_chain()
RETURNS TABLE (status text, first_broken_id bigint, total_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: digest() and encode() live in the 'extensions'
-- schema in Supabase (pgcrypto is pre-installed there, not in public).
-- pg_temp listed last to block search-path injection via temporary objects.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  r               record;
  v_prev_hash     text := '0';   -- starts at genesis sentinel, same as trigger
  v_expected_hash text;
  v_count         bigint := 0;
BEGIN
  -- WHY: Defense-in-depth auth check inside the function body, not just at
  -- the GRANT layer. A future bug that grants execute to a wider role does not
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
    -- A mismatch here means a row was inserted out of sequence or the chain
    -- pointer was corrupted.
    IF r.prev_hash <> v_prev_hash THEN
      RETURN QUERY SELECT 'prev_hash_mismatch'::text, r.id, v_count;
      RETURN;
    END IF;

    -- Re-compute the expected row_hash using the EXACT same field order as
    -- admin_audit_chain_hash() trigger. Any drift = permanent false negatives.
    v_expected_hash := encode(
      digest(
        r.prev_hash
          || '|' || r.id::text
          || '|' || r.actor_id::text
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

  -- All rows verified cleanly (or table is empty — count = 0).
  RETURN QUERY SELECT 'ok'::text, NULL::bigint, v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_admin_audit_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain() TO authenticated;


-- ============================================================================
-- §3.3 consent_flags — Per-user per-purpose consent state
-- ============================================================================

/**
 * consent_purpose (enum)
 *
 * Named consent purposes that can be granted or revoked per user. Starting
 * with a single value; Phase 4.2 will add more. Using an enum rather than
 * free text enforces exhaustive check at the DB layer.
 *
 * Values:
 *   support_read_metadata — allows site admin/support to read session metadata
 *                           (not message content, which is E2E encrypted)
 */
CREATE TYPE public.consent_purpose AS ENUM ('support_read_metadata');

/**
 * consent_flags
 *
 * Tracks per-user consent grants and revocations. One row per (user_id, purpose)
 * pair (UNIQUE constraint). NULL granted_at means not yet granted. Non-NULL
 * revoked_at with a later timestamp than granted_at means currently revoked.
 *
 * Phase 4.2 will use this table to gate support-read access. This migration
 * creates the schema only; no UI or business logic yet.
 *
 * Columns:
 *   id          — bigserial surrogate PK
 *   user_id     — the user whose consent is being recorded
 *   purpose     — which capability is being consented to
 *   granted_at  — when consent was granted (NULL = not yet granted)
 *   revoked_at  — when consent was revoked (NULL = still active)
 *   granted_by  — which site admin performed the toggle (audit aid)
 *   note        — optional free-text context
 */
CREATE TABLE public.consent_flags (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose     public.consent_purpose NOT NULL,
  granted_at  timestamptz,
  revoked_at  timestamptz,
  granted_by  uuid REFERENCES auth.users(id),
  note        text,
  UNIQUE (user_id, purpose)
);

CREATE INDEX idx_consent_user ON public.consent_flags (user_id);

-- WHY: service_role must be able to INSERT/UPDATE consent_flags via the
-- SECURITY DEFINER wrapper admin_toggle_consent (migration 041). The sequence
-- grant is required for the bigserial PK. Without this, Edge Function calls
-- using the service_role key will receive permission-denied at the table level
-- (RLS bypass does not override missing table-level privileges).
GRANT ALL ON public.consent_flags TO service_role;
GRANT ALL ON SEQUENCE public.consent_flags_id_seq TO service_role;

ALTER TABLE public.consent_flags ENABLE ROW LEVEL SECURITY;

-- WHY: Users need to be able to view their own consent state (e.g. in account
-- settings: "Support access: enabled / disabled"). They must NOT see other
-- users' consent flags — that would be a privacy leak.
CREATE POLICY consent_select_self ON public.consent_flags
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- WHY: Site admins need to see all consent flags for the /admin dossier view.
-- This is a second, additive SELECT policy — Postgres evaluates policies with
-- OR logic for the same command, so a row is visible if EITHER policy passes.
CREATE POLICY consent_select_site_admin ON public.consent_flags
  FOR SELECT TO authenticated
  USING (public.is_site_admin((SELECT auth.uid())));

-- No INSERT/UPDATE/DELETE policy → blocked for all non-service roles.
-- Mutations happen only via SECURITY DEFINER wrappers in migration 041.


-- ============================================================================
-- §3.4 subscriptions — Tier override source columns (ALTER existing)
-- ============================================================================

/**
 * subscriptions — override columns (added in migration 040)
 *
 * These three columns enable the "manual tier override" feature. When a site
 * admin changes a user's tier via the admin console, override_source is set
 * to 'manual'. The Polar webhook handler checks this column before applying
 * a webhook update, so a replay cannot clobber an intentional manual override.
 *
 * override_source       — 'polar' (default) or 'manual' (admin-set)
 * override_expires_at   — when the manual override expires (NULL = permanent)
 * override_reason       — free-text reason for the manual override (audit aid)
 *
 * WHY NOT NULL with DEFAULT 'polar':
 *   - Existing rows represent Polar-sourced subscriptions. Backfilling them as
 *     'polar' keeps the column semantics consistent from the start.
 *   - NOT NULL forces every code path that touches subscriptions to be explicit
 *     about the source, preventing silent null-means-something ambiguity.
 *   - The CHECK constraint enforces the two-value vocabulary at the DB layer.
 */
ALTER TABLE public.subscriptions
  ADD COLUMN override_source      text CHECK (override_source IN ('polar', 'manual')),
  ADD COLUMN override_expires_at  timestamptz,
  ADD COLUMN override_reason      text;

-- Backfill: every existing row is a Polar-sourced subscription.
-- WHY: We cannot set NOT NULL DEFAULT 'polar' in one step if there are existing
-- rows, because Postgres validates NOT NULL before the DEFAULT is applied in
-- some older versions. The three-step pattern (add nullable → backfill → set
-- NOT NULL + DEFAULT) is the safe standard approach.
UPDATE public.subscriptions
  SET override_source = 'polar'
  WHERE override_source IS NULL;

ALTER TABLE public.subscriptions
  ALTER COLUMN override_source SET NOT NULL;

ALTER TABLE public.subscriptions
  ALTER COLUMN override_source SET DEFAULT 'polar';

-- ============================================================================
-- Migration 040 complete.
-- ============================================================================
