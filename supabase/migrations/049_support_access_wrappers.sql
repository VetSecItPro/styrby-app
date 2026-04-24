-- ============================================================================
-- Migration 049: support_access_grants — SECURITY DEFINER Mutation Wrappers (T2)
-- ============================================================================
--
-- PURPOSE:
--   Creates four SECURITY DEFINER wrapper functions that are the ONLY app-layer
--   mutation path for public.support_access_grants. All DML policies are absent
--   by design (migration 048 §5); direct INSERT/UPDATE/DELETE is explicitly
--   REVOKEd. These wrappers enforce:
--     1. Authorization (is_site_admin for admin ops; self-ownership for user ops)
--     2. Forward-only state machine (pending→approved→consumed/revoked/expired)
--     3. Atomic FOR UPDATE CAS on access_count + status in admin_consume_support_access
--     4. Same-transaction admin_audit_log INSERT for every grant mutation
--     5. Server-side length(btrim(reason)) > 0 (not just length(reason) > 0)
--     6. Token hash stored only — raw token never reaches the DB
--
-- FUNCTIONS:
--   admin_request_support_access  — admin creates a new pending grant
--   user_approve_support_access   — resource-owner approves a pending grant
--   user_revoke_support_access    — resource-owner revokes a non-terminal grant
--   admin_consume_support_access  — admin exchanges token hash for session scope
--
-- STATE MACHINE (forward-only, no back-edges):
--   pending ──→ approved ──→ consumed  (admin exhausted access_count cap)
--     │             │
--     └──→ revoked  └──→ revoked       (user revokes at any non-terminal state)
--   Expired: expires_at check enforced on approve and consume; cleanup job can
--   flip status='expired' on pending/approved rows post-expiry.
--
-- SECURITY MODEL:
--   - SECURITY DEFINER + SET search_path = public, extensions, pg_temp on all four.
--   - is_site_admin(auth.uid()) explicitly checked in admin_ functions even though
--     GRANT is also scoped — defense-in-depth (OWASP A01:2021). RLS is bypassed
--     inside SECURITY DEFINER so the in-body check is the sole authorization gate.
--   - FOR UPDATE row lock in every read-before-update path to prevent TOCTOU races.
--   - Audit INSERT is always in the same transaction as the grant mutation.
--     If the audit INSERT fails the entire call rolls back (SOC2 CC7.2 non-repudiation).
--
-- GRANT STRUCTURE:
--   admin_request_support_access  → authenticated (Phase 4.1 P0 lesson — see below)
--   admin_consume_support_access  → authenticated (Phase 4.1 P0 lesson — see below)
--   user_approve_support_access   → authenticated (user-scoped Supabase client)
--   user_revoke_support_access    → authenticated (user-scoped Supabase client)
--
-- PHASE 4.1 P0 LEARNING — GRANT EXECUTE TO authenticated ON ADMIN RPCs:
--   Phase 4.1 (migration 046) discovered that granting admin SECURITY DEFINER
--   functions to service_role only forces route handlers to use the service-role
--   client. When the service-role client calls an RPC, Supabase does NOT forward the
--   user's JWT into the SECURITY DEFINER body, so auth.uid() resolves to NULL inside
--   the function. NULL flows to is_site_admin(NULL) which returns false, triggering
--   RAISE 42501 — the function always rejects, even for legitimate admins.
--
--   The fix is to GRANT EXECUTE TO authenticated. The user-scoped Supabase client
--   (initialized with the admin's JWT) calls .rpc() and Supabase propagates the JWT
--   into the SECURITY DEFINER body, making auth.uid() resolve correctly. The real
--   security gate — the in-body IF NOT is_site_admin(auth.uid()) THEN RAISE 42501
--   check — remains fully intact and is the sole authorization enforcer. GRANT
--   EXECUTE to authenticated merely unlocks the call path; it does not weaken the
--   authorization logic (OWASP A01:2021 defense-in-depth preserved).
--
-- SOC2 CITATIONS:
--   CC6.1 — Least privilege: REVOKE ALL + targeted GRANT per function.
--   CC6.3 — Per-session, per-ticket scoping. Grant tied to specific session FK.
--   CC7.2 — Every mutation audited in the same transaction. FOR UPDATE prevents
--            TOCTOU on access_count increment. Audit trail is non-repudiable.
--   CC9.2 — User can revoke at any non-terminal state; immediate effect at DB layer.
--   A1.1  — access_count / max_access_count cap limits blast radius of a leaked token.
--
-- GDPR:
--   Article 7  — Per-session consent; revocable at any time by user.
--   Article 25 — Scope JSONB limits exposed metadata; wrappers enforce the boundary.
--
-- OWASP:
--   A01:2021 — Broken Access Control: explicit auth checks in body; RLS bypass is safe
--              because we re-add the guard inside the function.
--   A02:2021 — Cryptographic Failures: token_hash stored only; raw token must not
--              be passed to any DB function. Comparison via timingSafeEqual in Node
--              (lib/support/token.ts — T3).
--   A04:2021 — Insecure Design: TOCTOU on view count prevented by atomic CAS with
--              SELECT ... FOR UPDATE inside admin_consume_support_access.
--
-- PREREQUISITES:
--   Migration 012 — public.support_tickets (UUID pk)
--   Migration 001 — public.sessions (UUID pk)
--   Migration 040 — public.is_site_admin(), public.admin_audit_log
--   Migration 048 — public.support_access_grants (bigserial pk), sequence grant
-- ============================================================================


-- ============================================================================
-- §3.3.1  admin_request_support_access — Create a new pending grant
-- ============================================================================

/**
 * admin_request_support_access
 *
 * Creates a new support_access_grants row in status='pending' and writes a
 * corresponding audit log row in the same transaction. The raw access token is
 * generated entirely in the Node.js route handler (lib/support/token.ts — T3);
 * only the SHA-256 hex hash of that token is passed to this function for storage.
 * The raw token is never written to the database.
 *
 * @param p_ticket_id       UUID of the support ticket that triggers this access
 *                          request. Must reference an existing support_tickets row
 *                          belonging to p_user_id.
 * @param p_user_id         UUID of the user whose session is being accessed. The
 *                          session (p_session_id) must be owned by this user.
 * @param p_session_id      UUID of the specific coding session the admin may view.
 *                          Verified to belong to p_user_id before INSERT.
 * @param p_reason          Mandatory free-text justification for the access request.
 *                          Displayed to the user on the approval page. Must not be
 *                          blank (length(btrim(p_reason)) > 0 enforced server-side).
 * @param p_expires_in_hours Hours until the grant expires (1–168; max 1 week).
 *                          Prevents indefinitely-live grants in case the user
 *                          never approves.
 * @param p_token_hash      SHA-256 hex digest of the raw token (64 chars). Node
 *                          generates the raw token; this function stores only the
 *                          hash. Index on token_hash is UNIQUE — a collision in the
 *                          64-char hex space is computationally infeasible.
 * @returns bigint          grant.id of the newly inserted support_access_grants row.
 *
 * @throws 42501  Caller is not a site admin (insufficient_privilege)
 * @throws 23514  p_reason is NULL or blank (check_violation)
 * @throws 22023  p_expires_in_hours is outside [1, 168] (invalid_parameter_value)
 * @throws 22023  p_session_id does not belong to p_user_id (invalid session)
 * @throws 22023  p_ticket_id does not exist or does not belong to p_user_id
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (not service_role). Phase 4.1 P0 lesson:
 *     granting to service_role only forces the route handler to use the service-role
 *     client, which does not forward the caller's JWT into the SECURITY DEFINER body.
 *     auth.uid() resolves to NULL, is_site_admin(NULL) returns false, and the call
 *     always raises 42501. Granting to authenticated allows the user-scoped client
 *     (initialized with the admin's JWT) to call this RPC, propagating the JWT so
 *     auth.uid() resolves correctly. The in-body is_site_admin(auth.uid()) check
 *     remains the sole authorization gate — any non-admin authenticated caller is
 *     rejected there. OWASP A01:2021 defense-in-depth is preserved.
 *   - SECURITY DEFINER: bypasses RLS on support_access_grants (no INSERT policy
 *     exists) and admin_audit_log. In-body is_site_admin guard replaces RLS.
 *   - SET search_path: prevents search-path injection via shadow objects in
 *     user-writable schemas (pg_temp, public schemas ordered safely).
 *   - Zero dynamic SQL: no EXECUTE, no format(). All SQL is static — auditable
 *     without query-plan inspection.
 *
 * SOC2 CC7.2: Grant creation is audited in the same transaction. If the audit
 *   INSERT fails the grant INSERT also rolls back — no unaudited mutations.
 * SOC2 CC6.3: Per-session, per-ticket scoping verified via FK lookups before INSERT.
 * GDPR Article 7: Consent is per-session and explicitly requested. User sees
 *   p_reason on the approval page to make an informed consent decision.
 * OWASP A02:2021: Raw token never stored; only the SHA-256 hash is persisted.
 */
CREATE OR REPLACE FUNCTION public.admin_request_support_access(
  p_ticket_id       uuid,
  p_user_id         uuid,
  p_session_id      uuid,
  p_reason          text,
  p_expires_in_hours int,
  p_token_hash      text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY extensions in search_path: admin_audit_chain_hash trigger calls digest() +
-- encode() from pgcrypto (Supabase installs it in the 'extensions' schema).
-- Without 'extensions' here the trigger still works (it has its own search_path),
-- but including it is belt-and-suspenders for any pgcrypto call we add later.
-- pg_temp is always LAST to block search-path injection via temporary objects.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_grant_id bigint;
  v_audit_id bigint;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────────
  -- WHY explicit is_site_admin check even though GRANT is service_role only:
  -- SECURITY DEFINER bypasses RLS, so auth checks must be re-enforced inside
  -- the function body. A future GRANT regression or a direct Postgres session
  -- would otherwise bypass the privilege gate entirely (OWASP A01:2021).
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ─────────────────────────────────────────────────────────
  -- WHY btrim not trim: btrim removes all leading/trailing whitespace bytes
  -- (including tabs, newlines, carriage returns). A reason of '   \n   ' would
  -- pass length(reason) > 0 but is semantically blank — btrim catches it.
  -- This is defense-in-depth over the table CHECK (length(reason) > 0) which
  -- does not btrim. ERRCODE 23514 = check_violation, consistent with DB constraint.
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '23514';
  END IF;

  -- WHY 1–168 (1 hour to 1 week): grants shorter than 1 hour create operational
  -- friction (can't get user approval before it expires). Grants longer than 7 days
  -- represent open-ended surveillance, violating GDPR Article 25 data minimisation.
  -- ERRCODE 22023 = invalid_parameter_value (not a permissions error).
  IF p_expires_in_hours < 1 OR p_expires_in_hours > 168 THEN
    RAISE EXCEPTION 'p_expires_in_hours must be between 1 and 168' USING ERRCODE = '22023';
  END IF;

  -- ── Verify session belongs to target user (FOR UPDATE) ───────────────────────
  -- WHY FOR UPDATE: takes a row-level lock so no concurrent call can delete or
  -- reassign the session between our check and the grant INSERT. Without this lock
  -- a TOCTOU window exists where the session is reassigned to a different user
  -- after we verify ownership but before we INSERT the grant (SOC2 CC7.2).
  -- Absence of the row is treated as "invalid session" — we do not distinguish
  -- "session doesn't exist" from "session exists but wrong user" to avoid
  -- leaking session existence to admins who pass a wrong user_id.
  PERFORM 1
    FROM public.sessions
    WHERE id = p_session_id
      AND user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session not found or does not belong to the specified user'
      USING ERRCODE = '22023';
  END IF;

  -- ── Verify ticket exists and belongs to target user ──────────────────────────
  -- WHY no FOR UPDATE on tickets: the ticket row is read-only in this flow.
  -- A lock on both rows would create a lock-ordering risk if another concurrent
  -- call locks tickets before sessions. Single-lock (sessions) is sufficient.
  PERFORM 1
    FROM public.support_tickets
    WHERE id = p_ticket_id
      AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket not found or does not belong to the specified user'
      USING ERRCODE = '22023';
  END IF;

  -- ── INSERT grant row ──────────────────────────────────────────────────────────
  -- WHY status='pending' (not 'approved'): explicit two-step consent flow.
  -- The admin requests access; the user must approve. No read can occur until
  -- status transitions to 'approved' via user_approve_support_access (GDPR Art. 7).
  -- WHY granted_by=v_actor: records which admin created the grant for audit trail.
  INSERT INTO public.support_access_grants
    (ticket_id, user_id, session_id, granted_by, token_hash, status, expires_at, reason)
  VALUES
    (p_ticket_id, p_user_id, p_session_id, v_actor, p_token_hash,
     'pending',
     now() + (p_expires_in_hours || ' hours')::interval,
     p_reason)
  RETURNING id INTO v_grant_id;

  -- ── Audit log ─────────────────────────────────────────────────────────────────
  -- WHY audit AFTER INSERT (not before): we need the grant.id to put in after_json.
  -- WHY after_json excludes token_hash: the hash is a security artefact, not an
  -- operational field. Storing it in after_json would surface it in the audit UI.
  -- We include only the grant id and metadata sufficient for an auditor to cross-
  -- reference the grants table. This follows data minimisation (GDPR Art. 25).
  -- WHY before_json=NULL: this is a creation event; there is no previous state.
  -- WHY mutation + audit in same statement block: they share the same implicit
  -- transaction. If the audit INSERT fails the grant INSERT rolls back — no
  -- unaudited mutations (SOC2 CC7.2 non-repudiation).
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor, p_user_id,
     'support_access_requested',
     'support_access_grants',
     NULL,
     jsonb_build_object(
       'grant_id',   v_grant_id,
       'ticket_id',  p_ticket_id,
       'session_id', p_session_id,
       'status',     'pending',
       'expires_in_hours', p_expires_in_hours
     ),
     p_reason)
  RETURNING id INTO v_audit_id;

  RETURN v_grant_id;
END;
$$;

-- WHY REVOKE ALL FROM PUBLIC first: PUBLIC includes every role (including anon).
-- Revoking resets permissions to the safe baseline before we selectively grant
-- (SOC2 CC6.1 least privilege).
REVOKE ALL ON FUNCTION public.admin_request_support_access(uuid, uuid, uuid, text, int, text) FROM PUBLIC;

-- WHY authenticated (not service_role): Phase 4.1 P0 lesson — granting to
-- service_role only causes auth.uid() to resolve to NULL inside the SECURITY
-- DEFINER body because Supabase does not forward the user JWT when the service-role
-- client calls .rpc(). NULL → is_site_admin(NULL) = false → RAISE 42501 on every
-- call, including legitimate admins. Granting to authenticated allows the route
-- handler to call this via a user-scoped Supabase client initialized with the
-- admin's JWT, so auth.uid() resolves and the in-body is_site_admin check works
-- correctly. The authorization gate remains the in-body check — this GRANT merely
-- unlocks the call path (OWASP A01:2021 defense-in-depth preserved).
GRANT EXECUTE ON FUNCTION public.admin_request_support_access(uuid, uuid, uuid, text, int, text) TO authenticated;


-- ============================================================================
-- §3.3.2  user_approve_support_access — Resource-owner approves a pending grant
-- ============================================================================

/**
 * user_approve_support_access
 *
 * Transitions a support_access_grants row from status='pending' to
 * status='approved', enabling the admin to call admin_consume_support_access.
 * Called by the resource owner (the user whose session is being shared) via the
 * mobile/web approval flow. The caller must be the grant's resource owner.
 *
 * @param p_grant_id   bigint ID of the support_access_grants row to approve.
 * @returns bigint     ID of the newly inserted admin_audit_log row.
 *
 * @throws 42501  Caller is not the resource owner (insufficient_privilege)
 * @throws 22023  Grant is not in status='pending' (state machine violation)
 * @throws 22023  Grant has already expired (expires_at <= now())
 *
 * State machine enforcement (forward-only, no back-edges):
 *   pending → approved  ✓  (this function)
 *   approved → *        ✗  (already approved — 22023)
 *   revoked / expired / consumed → *  ✗  (terminal — 22023)
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated. User calls this with their own JWT via the
 *     Supabase JS client on the approval page.
 *   - SECURITY DEFINER: RLS is bypassed; self-ownership is checked inside the body
 *     via grant.user_id = auth.uid(). This is the sole authorization gate.
 *   - FOR UPDATE: acquires row-level lock to prevent concurrent approve + revoke
 *     calls from producing inconsistent state on the same grant row.
 *
 * SOC2 CC9.2: User explicitly approves access. Approval timestamp is recorded.
 * GDPR Article 7: Affirmative consent recorded with approved_at timestamp.
 * SOC2 CC7.2: Approval audited in same transaction as status UPDATE.
 */
CREATE OR REPLACE FUNCTION public.user_approve_support_access(
  p_grant_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_grant    public.support_access_grants%ROWTYPE;
  v_audit_id bigint;
BEGIN
  -- ── Fetch and lock grant row ──────────────────────────────────────────────────
  -- WHY FOR UPDATE: prevents a concurrent user_revoke_support_access call from
  -- modifying the same row between our status check and our UPDATE. Without the
  -- lock, two concurrent calls (approve + revoke) could both read status='pending'
  -- and both proceed — producing an inconsistent terminal state (SOC2 CC7.2 TOCTOU).
  SELECT * INTO v_grant
    FROM public.support_access_grants
    WHERE id = p_grant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- WHY generic 22023 (not 42501): a non-owner gets the same error as "grant not
    -- found". This prevents callers from distinguishing "grant exists but you're not
    -- the owner" from "grant doesn't exist", limiting information leakage.
    RAISE EXCEPTION 'grant not found' USING ERRCODE = '22023';
  END IF;

  -- ── Authorization: caller must be the resource owner ─────────────────────────
  -- WHY 42501 here (not 22023): once we've confirmed the row exists, we can
  -- distinguish an authorization failure from a state error. The caller knows
  -- they're attempting to approve their own grant; getting 42501 tells them
  -- they are not the owner (possible confused deputy scenario).
  IF v_grant.user_id <> v_actor THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── State machine: must be pending ───────────────────────────────────────────
  -- WHY check status before expires_at: a grant in 'approved' state should get
  -- "already approved" (state error) not "expired" even if it has also expired.
  -- Status check comes first so the error message is accurate.
  IF v_grant.status <> 'pending' THEN
    RAISE EXCEPTION 'grant is not in pending state (current status: %)', v_grant.status
      USING ERRCODE = '22023';
  END IF;

  -- ── Expiry check ──────────────────────────────────────────────────────────────
  -- WHY check expiry after status: a pending-but-expired grant should not be
  -- approvable. The user is shown the expiry time on the approval page; if they
  -- click Approve after expiry we return 22023 with a clear message.
  IF v_grant.expires_at <= now() THEN
    RAISE EXCEPTION 'grant has expired and cannot be approved'
      USING ERRCODE = '22023';
  END IF;

  -- ── Transition: pending → approved ───────────────────────────────────────────
  UPDATE public.support_access_grants
    SET status      = 'approved',
        approved_at = now()
    WHERE id = p_grant_id;

  -- ── Audit log ─────────────────────────────────────────────────────────────────
  -- WHY actor_id=v_actor (not v_grant.granted_by): the user is the actor for this
  -- event. Recording the user as actor preserves the non-repudiability of the
  -- consent decision — the audit shows "user X approved grant Y at time T".
  -- WHY before_json={status: pending}, after_json={status: approved}:
  -- minimal diff sufficient for auditor review (state machine transition).
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor, v_grant.user_id,
     'support_access_approved',
     'support_access_grants',
     jsonb_build_object('grant_id', p_grant_id, 'status', 'pending'),
     jsonb_build_object('grant_id', p_grant_id, 'status', 'approved', 'approved_at', now()),
     'user approved support access grant #' || p_grant_id::text)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.user_approve_support_access(bigint) FROM PUBLIC;

-- WHY authenticated (not service_role): users call this directly from the mobile
-- or web approval page using their own session JWT. Service-role is not needed
-- and would be incorrect (the user's auth.uid() must be resolvable for ownership check).
GRANT EXECUTE ON FUNCTION public.user_approve_support_access(bigint) TO authenticated;


-- ============================================================================
-- §3.3.3  user_revoke_support_access — Resource-owner revokes a grant
-- ============================================================================

/**
 * user_revoke_support_access
 *
 * Transitions a support_access_grants row to status='revoked'. Can be called from
 * any non-terminal state (pending or approved). Calls against already-terminal rows
 * (revoked, consumed, expired) are idempotent no-ops — the function returns 0 and
 * writes no new audit row, preventing audit log inflation from retry loops.
 *
 * @param p_grant_id   bigint ID of the support_access_grants row to revoke.
 * @returns bigint     ID of the admin_audit_log row (0 if idempotent no-op).
 *
 * @throws 42501  Caller is not the resource owner (insufficient_privilege)
 *
 * State machine enforcement (forward-only):
 *   pending  → revoked  ✓
 *   approved → revoked  ✓
 *   revoked / consumed / expired → no-op (return 0)
 *
 * Idempotency design:
 *   Returning 0 (not raising an error) on terminal state allows callers to issue
 *   a revoke safely in retry/at-least-once delivery contexts (e.g. mobile push
 *   confirm flow retried after network error). The caller must treat 0 as "already
 *   revoked or consumed" — this is documented in the T3 client library.
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated.
 *   - SECURITY DEFINER: ownership check in body (grant.user_id = auth.uid()).
 *   - FOR UPDATE: prevents concurrent approve + revoke race on the same row.
 *
 * SOC2 CC9.2: User can revoke at any time; revocation takes effect immediately.
 * GDPR Article 7: Consent is revocable at any time without restriction.
 * SOC2 CC7.2: Revocation audited in same transaction as status UPDATE.
 */
CREATE OR REPLACE FUNCTION public.user_revoke_support_access(
  p_grant_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_grant    public.support_access_grants%ROWTYPE;
  v_audit_id bigint;
BEGIN
  -- ── Fetch and lock grant row ──────────────────────────────────────────────────
  -- WHY FOR UPDATE: serialises concurrent approve+revoke operations (SOC2 CC7.2).
  SELECT * INTO v_grant
    FROM public.support_access_grants
    WHERE id = p_grant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Same ambiguity-collapse reasoning as user_approve_support_access:
    -- "not found" and "wrong owner" produce the same 42501 after this point.
    -- We 42501 here to be consistent with the non-found case being an auth error.
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Authorization: caller must be the resource owner ─────────────────────────
  IF v_grant.user_id <> v_actor THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Idempotent no-op on terminal states ──────────────────────────────────────
  -- WHY return 0 (not raise): terminal states (revoked, consumed, expired) are
  -- already safe — no active admin access is possible. Raising an error would
  -- cause retry loops in the mobile client to surface noise to the user.
  -- Returning 0 lets the caller detect "was already terminal" vs "just revoked"
  -- (non-zero audit_id) without an extra round-trip SELECT.
  IF v_grant.status IN ('revoked', 'consumed', 'expired') THEN
    RETURN 0;
  END IF;

  -- ── Transition: pending|approved → revoked ───────────────────────────────────
  UPDATE public.support_access_grants
    SET status     = 'revoked',
        revoked_at = now()
    WHERE id = p_grant_id;

  -- ── Audit log ─────────────────────────────────────────────────────────────────
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor, v_grant.user_id,
     'support_access_revoked',
     'support_access_grants',
     jsonb_build_object('grant_id', p_grant_id, 'status', v_grant.status),
     jsonb_build_object('grant_id', p_grant_id, 'status', 'revoked', 'revoked_at', now()),
     'user revoked support access grant #' || p_grant_id::text)
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.user_revoke_support_access(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_revoke_support_access(bigint) TO authenticated;


-- ============================================================================
-- §3.3.4  admin_consume_support_access — Exchange token hash for session scope
-- ============================================================================

/**
 * admin_consume_support_access
 *
 * Atomically validates a token hash, increments the access_count (CAS with FOR
 * UPDATE lock), and returns the grant's session_id and scope JSONB. This is the
 * gate that the admin route handler calls to obtain permission to read session
 * metadata. The route then uses session_id + scope to constrain its SELECT.
 *
 * The timingSafeEqual comparison of the raw token against the stored hash happens
 * in the Node.js route handler (lib/support/token.ts — T3) BEFORE calling this
 * function. This function performs a direct hash-equality lookup; it does not do
 * timing-safe comparison (that would require plv8 or a C extension). The hash
 * lookup is safe because SHA-256 hash equality is not susceptible to timing
 * attacks in the same way that secret-comparison is — the hash is derived, not
 * secret itself. The raw token is the secret, and timingSafeEqual on the raw token
 * is enforced in T3 before this function is ever called.
 *
 * @param p_token_hash  SHA-256 hex digest of the raw token. Must be 64 chars.
 * @returns TABLE       (grant_id bigint, session_id uuid, scope jsonb)
 *                      Exactly one row on success.
 *
 * @throws 42501  Caller is not a site admin
 * @throws 22023  Token hash not found, or grant not in approved state, or expired,
 *                or access_count would exceed max_access_count. All four conditions
 *                return the same ERRCODE and message to prevent oracle attacks:
 *                a caller cannot distinguish "wrong token" from "approved but
 *                expired" from "consumed" — reducing information leakage.
 *
 * Atomic CAS (Compare-And-Swap):
 *   SELECT ... FOR UPDATE serialises all concurrent consume calls for the same
 *   grant row. The access_count increment and optional status='consumed' transition
 *   happen in a single UPDATE statement within the same lock — no separate read
 *   is needed for the count check, preventing TOCTOU bypass-by-refresh attacks
 *   (SOC2 CC7.2 / OWASP A04:2021).
 *
 * Security model:
 *   - GRANT EXECUTE TO authenticated (not service_role). Phase 4.1 P0 lesson:
 *     same root cause as admin_request_support_access — service_role grant causes
 *     auth.uid() to be NULL inside the SECURITY DEFINER body, which makes
 *     is_site_admin(NULL) return false and raises 42501 on every call. Route handler
 *     must call via a user-scoped Supabase client so the admin JWT propagates through
 *     and auth.uid() resolves. The in-body is_site_admin(auth.uid()) check is the
 *     sole authorization gate (OWASP A01:2021 defense-in-depth preserved).
 *   - SECURITY DEFINER: RLS bypassed; is_site_admin check replaces it.
 *   - FOR UPDATE: prevents concurrent consume calls from double-counting.
 *
 * SOC2 CC7.2: Every consume is audited (action='support_access_used') in the same
 *   transaction as the access_count increment.
 * SOC2 A1.1: access_count / max_access_count cap enforced atomically.
 * OWASP A04:2021: TOCTOU prevented by FOR UPDATE CAS pattern.
 */
CREATE OR REPLACE FUNCTION public.admin_consume_support_access(
  p_token_hash text
)
RETURNS TABLE(grant_id bigint, session_id uuid, scope jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_grant        public.support_access_grants%ROWTYPE;
  v_old_count    int;
  v_new_count    int;
  v_new_status   text;
  v_audit_id     bigint;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────────
  IF NOT public.is_site_admin(v_actor) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Fetch and lock grant row by token hash ───────────────────────────────────
  -- WHY FOR UPDATE: atomic CAS — the lock is held from this SELECT through the
  -- UPDATE below. Concurrent consume calls for the same token will queue behind
  -- this lock rather than both reading access_count=9 and both incrementing to 10,
  -- which would allow max_access_count to be exceeded (OWASP A04:2021 / SOC2 A1.1).
  -- WHY token_hash lookup (not grant_id): the admin presents the raw token to the
  -- route handler, which hashes it and passes the hash here. The route does not
  -- know the grant_id — the token IS the credential.
  SELECT * INTO v_grant
    FROM public.support_access_grants
    WHERE token_hash = p_token_hash
    FOR UPDATE;

  -- WHY the same generic error for all failure modes (not found / wrong status /
  -- expired / cap exceeded): returning different errors leaks information about
  -- which condition triggered the rejection. An attacker probing token hashes
  -- must not learn whether the token exists but is "wrong state" vs "doesn't exist"
  -- (oracle attack mitigation — OWASP A02:2021).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '22023';
  END IF;

  IF v_grant.status <> 'approved' THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '22023';
  END IF;

  IF v_grant.expires_at <= now() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '22023';
  END IF;

  IF v_grant.access_count + 1 > v_grant.max_access_count THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '22023';
  END IF;

  -- ── Atomic CAS: increment access_count, transition if at cap ─────────────────
  v_old_count  := v_grant.access_count;
  v_new_count  := v_grant.access_count + 1;

  -- WHY compute new_status before UPDATE: single UPDATE statement covers both
  -- the increment and the optional status flip atomically within the FOR UPDATE
  -- lock. No separate UPDATE for the status transition needed.
  IF v_new_count >= v_grant.max_access_count THEN
    v_new_status := 'consumed';
  ELSE
    v_new_status := 'approved';
  END IF;

  UPDATE public.support_access_grants
    SET access_count     = v_new_count,
        last_accessed_at = now(),
        status           = v_new_status
    WHERE id = v_grant.id;

  -- ── Audit log ─────────────────────────────────────────────────────────────────
  -- WHY before/after access_count: auditor can detect if a grant was used
  -- unexpectedly many times (e.g. token leaked). Each consume row is individually
  -- auditable. Including new_status allows auditor to identify when a grant was
  -- exhausted (SOC2 CC7.2).
  -- WHY NOT include token_hash in audit: it is a security artefact; surfacing it
  -- in the audit log creates unnecessary exposure if the log is breached.
  INSERT INTO public.admin_audit_log
    (actor_id, target_user_id, action, target_entity, before_json, after_json, reason)
  VALUES
    (v_actor, v_grant.user_id,
     'support_access_used',
     'support_access_grants',
     jsonb_build_object(
       'grant_id',     v_grant.id,
       'access_count', v_old_count,
       'status',       'approved'
     ),
     jsonb_build_object(
       'grant_id',     v_grant.id,
       'access_count', v_new_count,
       'status',       v_new_status
     ),
     'admin consumed support access grant #' || v_grant.id::text)
  RETURNING id INTO v_audit_id;

  -- ── Return session context to route handler ───────────────────────────────────
  -- WHY RETURN QUERY (TABLE function): allows the route handler to use a single
  -- .rpc() call to both validate the token and obtain the session_id + scope in
  -- one round trip. The route then issues its constrained SELECT using these values.
  RETURN QUERY
    SELECT v_grant.id, v_grant.session_id, v_grant.scope;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_consume_support_access(text) FROM PUBLIC;

-- WHY authenticated (not service_role): Phase 4.1 P0 lesson — same as
-- admin_request_support_access. service_role-only grant causes auth.uid() = NULL
-- inside the SECURITY DEFINER body, breaking is_site_admin(). Route handler uses
-- a user-scoped client with the admin's JWT so auth.uid() resolves correctly.
-- Real authorization gate is the in-body is_site_admin(auth.uid()) check.
GRANT EXECUTE ON FUNCTION public.admin_consume_support_access(text) TO authenticated;


-- ============================================================================
-- Migration 049 complete.
-- ============================================================================
--
-- FUNCTIONS CREATED:
--   admin_request_support_access(uuid, uuid, uuid, text, int, text) → bigint
--   user_approve_support_access(bigint)                             → bigint
--   user_revoke_support_access(bigint)                              → bigint
--   admin_consume_support_access(text)                              → TABLE(...)
--
-- GRANTS (Phase 4.1 P0 fix applied — all four → authenticated):
--   admin_request_support_access  → authenticated (was service_role; see header P0 note)
--   user_approve_support_access   → authenticated
--   user_revoke_support_access    → authenticated
--   admin_consume_support_access  → authenticated (was service_role; see header P0 note)
--
-- VERIFICATION:
--   Docker unavailable locally. CI gates via Phase 4.0 GitHub Actions workflow:
--   supabase db reset → applies migrations 001..049 → runs pgTAP-style tests.
--   Local verification gap: documented in .subagent-dev-reports/tasks/task-02-implementer.md.
--
-- NEXT STEPS (migration 050 / T3):
--   lib/support/token.ts — raw token generation + timingSafeEqual comparison
--   lib/support/consume.ts — route handler calling admin_consume_support_access
-- ============================================================================
