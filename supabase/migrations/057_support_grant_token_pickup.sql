-- ============================================================================
-- Migration 057: support_grant_token_pickup — Server-side One-Time Token Channel
-- ============================================================================
--
-- PURPOSE:
--   Eliminates the client-readable cookie channel previously used to deliver the
--   raw support-grant token from `requestSupportAccessAction` (server action) to
--   the success page render. The cookie was non-HttpOnly because the success page
--   needed to clear it client-side after first read; that meant any same-origin
--   XSS within the 60-second window could read `document.cookie` and exfiltrate
--   the raw token, then call `admin_consume_support_access` from the attacker's
--   browser to obtain victim session metadata.
--
--   This migration introduces a server-only holding table + two SECURITY DEFINER
--   RPCs that allow the action to "stash" a raw token and the success-page
--   server component to "pick it up" exactly once. The token never crosses to
--   any client-readable storage. It exists only:
--     (a) briefly in the action's process memory (≤1 statement after stash)
--     (b) in the holding table for ≤60 seconds, RLS-locked with no SELECT policy
--     (c) in the HTML response body of the success page for one render
--
-- SECURITY CONTEXT:
--   Closes SEC-ADV-001 from /sec-ship --comprehensive (2026-04-24). PR #164
--   (sameSite='strict') eliminated cross-site CSRF leak vectors but left the
--   intra-origin XSS window open. This migration removes the channel entirely:
--   defense-in-depth via architecture change, not just hardening.
--
-- OBJECTS CREATED:
--   public.support_grant_token_pickup       — holding table (RLS-on, no policies)
--   public.admin_stash_grant_token(...)     — SECURITY DEFINER, INSERT row
--   public.admin_pickup_grant_token(bigint) — SECURITY DEFINER, atomic SELECT+DELETE
--   public.cleanup_support_grant_token_pickup() — sweep stale rows
--   pg_cron job 'styrby_cleanup_grant_token_pickup' — calls cleanup hourly
--
-- DATA LIFECYCLE:
--   1. Admin submits the request-access form.
--   2. requestSupportAccessAction generates raw token, calls
--      admin_request_support_access (writes hash + grant row).
--   3. Action calls admin_stash_grant_token(grant_id, raw_token) — INSERT.
--   4. Action redirects to /…/success?grant=<id>.
--   5. Success page (server component) calls admin_pickup_grant_token(grant_id):
--        - Validates is_site_admin(auth.uid()) AND admin == grant.granted_by.
--        - Locks the pickup row FOR UPDATE.
--        - If consumed_at IS NOT NULL → 22023 ('already consumed').
--        - If created_at < now() - 60s → 22023 ('expired').
--        - DELETEs the row, returns raw_token.
--   6. Page renders token in JSX once. Reload finds no row → 22023 → "expired".
--   7. Cron sweep removes any orphaned rows older than 5 minutes.
--
-- THREAT MODEL DELTA:
--   Before: XSS in any same-origin page within 60s of grant creation → reads
--           cookie → calls admin_consume_support_access from attacker browser.
--   After:  XSS still cannot read the token. The pickup RPC requires the admin's
--           own JWT (auth.uid() must equal grant.granted_by) AND consumes the
--           row atomically. Even a perfect XSS payload on the success page sees
--           the token in the rendered HTML — but the page only renders for the
--           legitimate admin in the first place (middleware T3 + is_site_admin
--           gates the route), and after first render the row is gone. No second
--           browser can re-fetch it. Blast radius: one render to one origin to
--           one admin.
--
-- SOC 2 CITATIONS:
--   CC6.1 — Least privilege: REVOKE ALL + targeted GRANT EXECUTE; no DML
--           policies on the table; no SELECT policy at all.
--   CC6.3 — Token bound to grant_id which is bound to admin via granted_by.
--           Pickup requires (a) is_site_admin (b) caller == granted_by.
--   CC7.2 — Pickup is atomic via FOR UPDATE row lock; double-pickup impossible.
--           Cron cleanup keeps audit-relevant rows from lingering.
--   A1.1  — 60-second TTL caps blast radius; hourly cron is belt-and-suspenders.
--
-- GDPR:
--   Article 25 (data minimisation) — raw token persisted ≤60s in holding table,
--                                    deleted on first pickup or by cron sweep.
--
-- OWASP:
--   A01:2021 — Broken Access Control: in-body is_site_admin + granted_by guard.
--   A02:2021 — Cryptographic Failures: raw token never reaches client storage.
--   A04:2021 — Insecure Design: atomic CAS via FOR UPDATE prevents TOCTOU /
--              double-pickup races.
--
-- PREREQUISITES:
--   Migration 040 — public.is_site_admin(), public.admin_audit_log
--   Migration 048 — public.support_access_grants (bigserial pk + granted_by FK)
-- ============================================================================


-- ============================================================================
-- §1 — Holding table
-- ============================================================================

-- WHY a separate table (not a column on support_access_grants):
--   Adding raw_token to support_access_grants would store the secret alongside
--   long-lived audit metadata. The whole point of token_hash is that the raw
--   token never persists in the grants row. A dedicated short-lived table keeps
--   the secret material on its own retention path (≤60s) without polluting the
--   main grants schema. Keeps 048 invariants intact (OWASP A02:2021).
CREATE TABLE IF NOT EXISTS public.support_grant_token_pickup (
  -- One pickup row per grant. PK + FK both point to support_access_grants.id.
  -- WHY ON DELETE CASCADE: if a grant is somehow deleted, no orphan pickup
  -- row should remain holding the raw token (data-integrity safety).
  grant_id     bigint PRIMARY KEY
                 REFERENCES public.support_access_grants(id) ON DELETE CASCADE,

  -- Raw token (43-char base64url after generateSupportToken). Stored ONLY here
  -- and ONLY for ≤60s. Never copied anywhere else server-side.
  -- WHY text (not bytea): generateSupportToken returns base64url-encoded ASCII;
  -- the caller and consumer both treat it as a string. text avoids encoding
  -- conversions on every read.
  raw_token    text        NOT NULL,

  -- Stash time. Used by admin_pickup_grant_token to enforce the 60s freshness
  -- window and by the cleanup cron to sweep orphans.
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Once a successful pickup occurs the row is DELETEd, not flagged consumed.
  -- WHY a column at all then: defense-in-depth — if a future migration changes
  -- the pickup RPC to UPDATE-instead-of-DELETE for any reason, the column is
  -- already there to record the consumption attempt without a schema change.
  -- Today, this column is never set to non-NULL because pickup deletes the row.
  consumed_at  timestamptz
);

COMMENT ON TABLE public.support_grant_token_pickup IS
  'Server-only one-time holding table for raw support-grant tokens. '
  'Replaces the previous non-HttpOnly cookie channel that exposed tokens to '
  'XSS within a 60s window. Rows live ≤60s and are deleted on pickup or by '
  'the styrby_cleanup_grant_token_pickup cron job. Closes SEC-ADV-001.';

-- WHY an index on created_at: the cleanup cron filters by created_at < now() - X.
-- Without an index it would full-scan every run. Partial index trimmed to rows
-- not yet consumed (consumed_at IS NULL) keeps the index tiny in steady state.
CREATE INDEX IF NOT EXISTS idx_support_grant_token_pickup_created
  ON public.support_grant_token_pickup(created_at)
  WHERE consumed_at IS NULL;


-- ============================================================================
-- §2 — Row Level Security (deny-by-default; no policies)
-- ============================================================================

-- WHY ENABLE without any policies: every direct query from authenticated/anon
-- roles returns zero rows. The only way to read raw_token is through the
-- SECURITY DEFINER pickup RPC below. SOC2 CC6.1 deny-by-default.
ALTER TABLE public.support_grant_token_pickup ENABLE ROW LEVEL SECURITY;

-- WHY explicit REVOKE in addition to "no policies":
--   REVOKE ensures that even if a future migration accidentally CREATE POLICYs
--   a permissive rule, the underlying table privilege denial fires first
--   (42501 insufficient_privilege) before any policy is evaluated. Defense in
--   depth at the privilege layer (mirrors 048 §6).
REVOKE ALL ON public.support_grant_token_pickup
  FROM PUBLIC, authenticated, anon;

-- service_role bypasses RLS in Supabase but still needs explicit table grants
-- to execute DML. Used only by SECURITY DEFINER functions below; no app code
-- should reach this table directly.
GRANT ALL ON public.support_grant_token_pickup TO service_role;


-- ============================================================================
-- §3 — admin_stash_grant_token: insert raw token immediately after grant create
-- ============================================================================

/**
 * admin_stash_grant_token
 *
 * Persists the raw support-grant token in the server-only pickup table so the
 * success-page server component can fetch it once during the next request
 * without ever exposing it to client-readable storage.
 *
 * Called by requestSupportAccessAction immediately after
 * admin_request_support_access returns the grant_id.
 *
 * @param p_grant_id   bigint — id returned by admin_request_support_access.
 * @param p_raw_token  text   — raw base64url token (43 chars). The matching
 *                              SHA-256 hash is already in support_access_grants
 *                              from the prior RPC call.
 * @returns void
 *
 * @throws 42501  Caller is not a site admin OR caller is not the grant's
 *                granted_by. We collapse both into 42501 because the legitimate
 *                action always satisfies both conditions (admin who just created
 *                the grant). Distinguishing them would leak information about
 *                whether a given grant_id exists.
 * @throws 22023  Pickup row already exists for this grant (someone called stash
 *                twice). The action calls this exactly once per grant — a
 *                duplicate indicates either replay or programming error; either
 *                way we reject rather than overwrite.
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated. The user-scoped Supabase client (admin's
 *     JWT) calls this so auth.uid() resolves correctly inside the body
 *     (Phase 4.1 P0 lesson — see 049 header).
 *   - SECURITY DEFINER + SET search_path = public, extensions, pg_temp.
 *   - In-body is_site_admin guard re-enforces auth (RLS bypassed in DEFINER).
 *   - granted_by check ensures only the admin who created the grant can stash
 *     its token. A different admin holding a stolen grant_id cannot inject a
 *     replacement raw_token.
 *
 * SOC2 CC6.1, CC6.3, CC7.2 / OWASP A01:2021, A02:2021.
 */
CREATE OR REPLACE FUNCTION public.admin_stash_grant_token(
  p_grant_id  bigint,
  p_raw_token text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_granted_by uuid;
BEGIN
  -- ── Authorization ──────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input sanity ───────────────────────────────────────────────────────────
  -- WHY length check (not just NOT NULL): an empty string would be silently
  -- stashed and later picked up as the grant's "raw token", which would never
  -- match any hash. Failing fast surfaces the bug instead of letting the admin
  -- believe a token was issued.
  IF p_raw_token IS NULL OR length(p_raw_token) < 16 THEN
    RAISE EXCEPTION 'raw token missing or too short' USING ERRCODE = '22023';
  END IF;

  -- ── Verify caller created this grant ───────────────────────────────────────
  -- WHY look up granted_by here (not pass it from app): the database is the
  -- source of truth. A tampered FormData granted_by would be ignored. We pull
  -- the value the prior RPC stored in support_access_grants.granted_by and
  -- compare to auth.uid() inside the SECURITY DEFINER body.
  SELECT granted_by INTO v_granted_by
    FROM public.support_access_grants
    WHERE id = p_grant_id;

  IF NOT FOUND OR v_granted_by IS NULL OR v_granted_by <> v_actor THEN
    -- Same 42501 to avoid leaking grant existence (see header note).
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── INSERT pickup row ──────────────────────────────────────────────────────
  -- WHY no ON CONFLICT: a duplicate stash is unexpected. The action calls this
  -- exactly once. A second call almost certainly indicates replay or bug; we
  -- reject loudly so the failure is visible. SQLSTATE 23505 (unique_violation)
  -- bubbles to the action which maps it to a generic error.
  INSERT INTO public.support_grant_token_pickup (grant_id, raw_token)
    VALUES (p_grant_id, p_raw_token);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_stash_grant_token(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_stash_grant_token(bigint, text) TO authenticated;


-- ============================================================================
-- §4 — admin_pickup_grant_token: atomic one-time fetch
-- ============================================================================

/**
 * admin_pickup_grant_token
 *
 * Atomically returns the raw token for a previously stashed grant and DELETEs
 * the pickup row in the same transaction. After this call the row is gone —
 * a second call (e.g. page reload) returns 22023 ('expired or already consumed')
 * indistinguishably from a never-stashed grant_id.
 *
 * @param p_grant_id   bigint — grant id from the success-page query string.
 * @returns text       — raw token (43 chars).
 *
 * @throws 42501  Caller is not a site admin OR caller is not grant.granted_by.
 *                Collapsed to a single error to avoid leaking grant existence.
 * @throws 22023  No pickup row for this grant (never stashed, already consumed,
 *                or expired by the 60-second TTL). Identical message in all
 *                three cases — admin sees "token unavailable" without learning
 *                whether the grant_id is valid.
 *
 * Atomicity:
 *   SELECT ... FOR UPDATE locks the row; the DELETE inside the same lock
 *   guarantees that two concurrent pickup calls cannot both return the token.
 *   The first wins; the second waits, finds the row gone, and raises 22023
 *   (SOC2 CC7.2 / OWASP A04:2021).
 *
 * TTL enforcement:
 *   60 seconds matches the previous cookie maxAge so the operational window
 *   is unchanged. The cleanup cron deletes orphans at >5 minutes for safety,
 *   but the RPC's own 60s freshness check is the primary control.
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (Phase 4.1 P0 lesson — see 049 header).
 *   - SECURITY DEFINER + SET search_path locked.
 *   - In-body is_site_admin guard.
 *   - granted_by check: only the admin who created the grant can pick up its
 *     token. A different admin (or a non-admin) gets 42501.
 *
 * SOC2 CC6.1, CC6.3, CC7.2 / OWASP A01:2021, A02:2021, A04:2021.
 */
CREATE OR REPLACE FUNCTION public.admin_pickup_grant_token(
  p_grant_id bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_granted_by uuid;
  v_raw_token  text;
  v_created_at timestamptz;
BEGIN
  -- ── Authorization (1/2): is_site_admin ─────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Authorization (2/2): caller must be the grant's granted_by ─────────────
  -- WHY check granted_by: defense-in-depth. is_site_admin alone would let any
  -- admin pick up another admin's freshly-issued token. Constraining to the
  -- creator means only the browser session that issued the grant can render
  -- the token — even if a second admin tab somehow learned the grant_id.
  SELECT granted_by INTO v_granted_by
    FROM public.support_access_grants
    WHERE id = p_grant_id;

  IF NOT FOUND OR v_granted_by IS NULL OR v_granted_by <> v_actor THEN
    -- Collapse to 42501; do not distinguish from missing pickup row.
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Atomic fetch + freshness check + delete ────────────────────────────────
  -- WHY FOR UPDATE: serialises concurrent pickup calls so exactly one returns
  -- the token. Without the lock, two requests could both read raw_token before
  -- either DELETE landed (TOCTOU — OWASP A04:2021).
  SELECT raw_token, created_at
    INTO v_raw_token, v_created_at
    FROM public.support_grant_token_pickup
    WHERE grant_id = p_grant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token expired or already consumed' USING ERRCODE = '22023';
  END IF;

  -- WHY 60s TTL inside the RPC (in addition to the cron sweep):
  --   The cron runs hourly; without an in-RPC TTL a row could linger up to ~1h
  --   if the admin opened the URL late. 60s matches the prior cookie maxAge,
  --   so behaviour is identical to the legacy path: token is unavailable after
  --   one minute even if the admin never visited the success page.
  IF v_created_at < now() - interval '60 seconds' THEN
    -- Delete the stale row inline so the cron does not have to (defense in depth).
    DELETE FROM public.support_grant_token_pickup WHERE grant_id = p_grant_id;
    RAISE EXCEPTION 'token expired or already consumed' USING ERRCODE = '22023';
  END IF;

  -- WHY DELETE (not UPDATE consumed_at): once the token is returned we never
  -- need the row again. DELETE leaves no residue of the secret. The
  -- consumed_at column exists only as a future-extension hook (see §1 comment).
  DELETE FROM public.support_grant_token_pickup WHERE grant_id = p_grant_id;

  RETURN v_raw_token;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_pickup_grant_token(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_pickup_grant_token(bigint) TO authenticated;


-- ============================================================================
-- §5 — Cleanup function + cron
-- ============================================================================

/**
 * cleanup_support_grant_token_pickup
 *
 * Sweeps orphaned pickup rows (>5 minutes old) so the table never grows in the
 * face of admins who request grants but never visit the success page. The
 * primary TTL is enforced by admin_pickup_grant_token (60 seconds); this
 * cleanup is belt-and-suspenders.
 *
 * @returns integer — number of rows deleted.
 *
 * Security model:
 *   - SECURITY DEFINER (DELETE without policies requires owner privileges).
 *   - GRANT EXECUTE TO postgres only (cron runs as superuser).
 *   - No auth.uid() check: invoked by pg_cron, not by users.
 *
 * SOC2 A1.1: bounded retention; raw tokens never persist beyond their TTL.
 * GDPR Article 25: data minimisation — token material removed automatically.
 */
CREATE OR REPLACE FUNCTION public.cleanup_support_grant_token_pickup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  -- WHY 5 minutes (not 60s): the in-RPC TTL is 60s, so any row past 5 minutes
  -- is unambiguously orphaned (admin never visited success page or closed it
  -- before pickup). 5min cushion absorbs clock skew without holding tokens.
  DELETE FROM public.support_grant_token_pickup
    WHERE created_at < now() - interval '5 minutes';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_support_grant_token_pickup() FROM PUBLIC;
-- WHY no GRANT to authenticated: only pg_cron (postgres role) should call this.
-- App code has no need to invoke cleanup; the in-RPC TTL handles per-call freshness.

-- WHY register cron here: Supabase pins pg_cron to pg_catalog (not extensions).
-- cron.schedule() upserts by name — re-running this migration is idempotent.
-- Schedule: every hour at :15 to spread load away from other styrby_* crons
-- (sessions cleanup at :00, exports at :30 — see migration 025).
SELECT cron.schedule(
  'styrby_cleanup_grant_token_pickup',
  '15 * * * *',  -- hourly at :15 past the hour
  $$SELECT public.cleanup_support_grant_token_pickup()$$
);


-- ============================================================================
-- Migration 057 complete.
-- ============================================================================
--
-- TABLE CREATED:
--   public.support_grant_token_pickup
--     - PK/FK grant_id → support_access_grants(id) ON DELETE CASCADE
--     - RLS enabled, no policies (server-only)
--     - INSERT/UPDATE/DELETE revoked from authenticated/anon/PUBLIC
--
-- FUNCTIONS CREATED:
--   admin_stash_grant_token(bigint, text)        → void   [GRANT authenticated]
--   admin_pickup_grant_token(bigint)             → text   [GRANT authenticated]
--   cleanup_support_grant_token_pickup()         → int    [no app GRANT]
--
-- CRON JOB:
--   styrby_cleanup_grant_token_pickup @ '15 * * * *'
--
-- VERIFICATION:
--   Phase 4.0 CI runs `supabase db reset` against migrations 001..057 and
--   re-runs against itself for idempotency. The cron.schedule() call is
--   idempotent by name; the CREATE TABLE / CREATE INDEX / CREATE FUNCTION
--   statements all use IF NOT EXISTS or OR REPLACE.
-- ============================================================================
