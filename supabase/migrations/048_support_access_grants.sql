-- ============================================================================
-- Migration 048: support_access_grants — Consent-Gated Session Access
-- ============================================================================
--
-- PURPOSE:
--   Introduces the support_access_grants table, which tracks per-session,
--   per-ticket support access grants from admins to users' session metadata.
--   An admin requests access; the user approves or revokes; every access is
--   counted and audited. No message content is ever exposed — metadata only.
--
-- WHY a dedicated table (not a column on support_tickets):
--   A single ticket may require access to multiple sessions over its lifetime.
--   Separate rows allow independent expiry, per-session revocation, and precise
--   view-count tracking without a complex JSONB array on the ticket row.
--
-- SECURITY MODEL:
--   - RLS enabled; deny-by-default.
--   - Two SELECT policies: self (user_id = auth.uid()) and site_admin.
--   - NO INSERT/UPDATE/DELETE policies — all mutations flow through
--     SECURITY DEFINER wrappers (migration 049, T2). This is intentional:
--     the wrappers enforce authorization, validate token hashes, and write
--     audit rows atomically. Direct DML from app layer is architecturally
--     forbidden, not just access-controlled.
--   - UPDATE + DELETE explicitly REVOKED from authenticated/anon/PUBLIC
--     (defense-in-depth: prevents accidental future GRANT regressions).
--   - service_role retains ALL for webhook and admin tooling.
--   - Token stored as SHA-256 hex hash; raw token never touches the DB.
--     Comparison must use timingSafeEqual in the Node layer (see lib/support/token.ts).
--
-- SOC2 CITATIONS:
--   CC6.1 — Least privilege enforced at DB layer via REVOKE + no DML policies.
--   CC6.3 — Per-session scoping; no blanket "support access" mode.
--   CC7.2 — Every access (approve, use, revoke) audited to admin_audit_log
--            via the SECURITY DEFINER wrappers in T2. View counts are
--            incremented atomically to prevent bypass-by-refresh attacks.
--   CC9.2 — User can revoke access at any time; revocation takes effect
--            immediately at the DB row level (status='revoked').
--   A1.1  — access_count / max_access_count cap limits blast radius of a
--            compromised or leaked raw token.
--
-- GDPR:
--   Article 7  — Consent per session, not blanket; revocable at any time.
--   Article 25 — Data minimisation: scope jsonb lists only the fields the
--                admin may read; route enforces this at SELECT time.
--
-- OWASP:
--   A01:2021 — Broken Access Control: deny-by-default RLS + explicit REVOKE.
--   A02:2021 — Cryptographic Failures: token stored only as SHA-256 hash;
--              raw token is one-time display only, never persisted.
--   A04:2021 — Insecure Design: TOCTOU on view count prevented by atomic
--              CAS in admin_consume_support_access wrapper (T2).
--
-- PREREQUISITES:
--   Migration 012 — public.support_tickets (UUID pk)
--   Migration 001 — public.sessions (UUID pk)
--   Migration 040 — public.consent_purpose enum, is_site_admin()
--   Migration 041 — public.admin_audit_log (action enum, FK structure)
--
-- SELF-TEST NOTE:
--   A DO $$ self-test block is intentionally OMITTED from this migration.
--   Rationale: inserting a test row requires bypassing RLS (which is correct
--   behaviour — no INSERT policy exists). A direct superuser INSERT would
--   succeed, but it provides no signal about the RLS invariants under test.
--   All five RLS invariants are instead covered by the pgTAP-style test file
--   at supabase/tests/rls/support_access_grants_rls.sql, which uses the
--   _rls_test_impersonate() harness and exercises each principal (non-owner,
--   owner, admin) against real RLS policy evaluation. Docker/CI gates this.
-- ============================================================================


-- ============================================================================
-- §1 — Extend consent_purpose enum
-- ============================================================================

-- WHY IF NOT EXISTS: idempotent; safe to re-run if migration is applied
-- against a DB that somehow already has this value. ADD VALUE commits
-- immediately outside a transaction in Postgres — no transaction wrapping needed.
ALTER TYPE public.consent_purpose ADD VALUE IF NOT EXISTS 'support_session_read';


-- ============================================================================
-- §2 — support_access_grants table
-- ============================================================================

/*
 * support_access_grants
 *
 * Tracks admin requests to view the metadata (never content) of a user's
 * specific coding session for support/debug purposes.
 *
 * LIFECYCLE:
 *   1. Admin calls admin_request_support_access() → status='pending', token_hash set
 *   2. User approves via user_approve_support_access() → status='approved'
 *      OR user revokes via user_revoke_support_access() → status='revoked'
 *   3. Admin reads session via admin_consume_support_access() →
 *      access_count incremented; status→'consumed' when access_count >= max_access_count
 *   4. expires_at is checked on every consume; expired rows can also be
 *      transitioned to status='expired' by a scheduled cleanup job.
 *
 * COLUMN NOTES:
 *   token_hash     — SHA-256 hex of the raw token. Raw token displayed once
 *                    to admin post-creation, then discarded. Never re-derivable.
 *   scope          — Allowlist of session metadata fields the admin may read.
 *                    Default matches the fields from spec §3.1 threat model.
 *                    Route enforces this at SELECT time via Zod schema.
 *   access_count   — Incremented atomically by admin_consume_support_access().
 *                    Combined with max_access_count, caps total reads per grant.
 *   max_access_count — Reasonable default of 10. Admin can request a higher cap
 *                    as a separate grant or by creating a new grant row.
 *   reason         — Admin's stated justification for the access request.
 *                    CHECK (length > 0) prevents empty-string bypass of the field.
 *
 * @see supabase/migrations/049_support_access_wrappers.sql (T2 — SECURITY DEFINER wrappers)
 * @see supabase/tests/rls/support_access_grants_rls.sql (RLS test suite)
 * @see lib/support/token.ts (T3 — raw token generation + timingSafeEqual comparison)
 */
CREATE TABLE public.support_access_grants (
  -- Primary key: bigserial for ordering and pagination efficiency.
  -- WHY bigserial not UUID: grants are sequential log-like rows; bigserial
  -- enables cheap ORDER BY id queries and is consistent with admin_audit_log.
  id               bigserial PRIMARY KEY,

  -- The support ticket that triggered this access request.
  -- ON DELETE CASCADE: if the ticket is deleted (e.g. spam removal), all
  -- associated grants are also cleaned up — no orphaned grants.
  ticket_id        uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,

  -- The user who owns the session being accessed (resource owner).
  -- This is the user who must approve the grant; RLS self-access policy
  -- uses this column to scope SELECT visibility.
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The specific coding session whose metadata may be read.
  -- Per-session scoping is the core privacy guarantee: no blanket access.
  session_id       uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,

  -- The admin who requested access. FK without ON DELETE CASCADE because:
  -- (a) if an admin account is deleted, the historical grant record must be
  -- preserved for audit continuity (SOC2 CC7.2 non-repudiation).
  -- (b) we intentionally want a FK violation to alert on orphaned grants.
  granted_by       uuid NOT NULL REFERENCES auth.users(id),

  -- SHA-256 hex digest of the raw token. Raw token is shown once to admin
  -- and then discarded. Stored hash allows server-side lookup + comparison
  -- via timingSafeEqual in lib/support/token.ts. UNIQUE enforced by index.
  token_hash       text NOT NULL,

  -- Grant lifecycle state machine:
  --   pending  → user has not yet responded to the access request
  --   approved → user approved; admin may consume the token
  --   revoked  → user revoked access (either before or after approval)
  --   expired  → expires_at has elapsed; cleanup job sets this
  --   consumed → access_count reached max_access_count; grant is exhausted
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'revoked', 'expired', 'consumed')),

  -- Allowlist of session metadata fields the admin may read.
  -- Default: action names, tool names, timestamps, token counts, status.
  -- Excludes 'content' (E2E encrypted message bodies — never accessible).
  -- WHY JSONB not text[]: extensible without schema change; allows future
  -- per-field read constraints (e.g. time-window for 'timestamp' field).
  scope            jsonb NOT NULL
                   DEFAULT '{"fields": ["action", "tool", "timestamp", "tokens", "status"]}'::jsonb,

  -- Hard expiry for the grant. Checked on every consume call.
  -- After this timestamp, admin_consume_support_access() will reject the token.
  expires_at       timestamptz NOT NULL,

  -- Timestamp of the original access request. Used for audit trail ordering.
  requested_at     timestamptz NOT NULL DEFAULT now(),

  -- Set when user approves the grant. NULL until approval.
  approved_at      timestamptz,

  -- Set when user revokes the grant. NULL unless explicitly revoked.
  revoked_at       timestamptz,

  -- Set on each successful consume call (last access timestamp for user dashboard).
  last_accessed_at timestamptz,

  -- Running count of admin reads against this grant. Incremented atomically
  -- in admin_consume_support_access() using SELECT ... FOR UPDATE to prevent
  -- TOCTOU race between count check and increment (SOC2 CC7.2 / CC4.1).
  access_count     int NOT NULL DEFAULT 0,

  -- Maximum number of reads allowed before the grant is auto-consumed.
  -- Default 10 is a reasonable cap for debug scenarios. Prevents a single
  -- grant from being used for bulk exfiltration if the raw token is leaked.
  max_access_count int NOT NULL DEFAULT 10,

  -- Admin's written justification for the access request. Required (CHECK
  -- on length > 0 prevents empty-string bypass). Displayed to the user on
  -- the approval page so they can make an informed decision.
  reason           text NOT NULL,
  CHECK (length(reason) > 0)
);


-- ============================================================================
-- §3 — Indexes
-- ============================================================================

-- Index 1: ticket-scoped lookup — admin support console lists all grants
-- for a ticket. Non-partial because we want pending/revoked/expired rows too.
CREATE INDEX idx_support_access_grants_ticket
  ON public.support_access_grants (ticket_id);

-- Index 2: user active grants — user dashboard shows pending/approved grants.
-- Partial WHERE status='approved' keeps the index small; the dashboard only
-- queries for active, actionable grants (not historical).
-- WHY include expires_at in the index: the route filters expires_at > now()
-- — including it allows index-only scans for the common dashboard query:
--   WHERE user_id=$1 AND status='approved' AND expires_at > now()
CREATE INDEX idx_support_access_grants_user_active
  ON public.support_access_grants (user_id, status, expires_at)
  WHERE status = 'approved';

-- Index 3: session-scoped lookup — session detail page shows active grants
-- for that session to render the "⚠️ Support has viewed this session" banner.
CREATE INDEX idx_support_access_grants_session
  ON public.support_access_grants (session_id);

-- Index 4: token hash lookup — used by admin_consume_support_access() to find
-- the grant row given only the hashed token. UNIQUE constraint enforces that
-- no two grants can share the same token hash (collision prevention).
-- WHY UNIQUE here not in table definition: keeps table definition clean;
-- the unique index is the mechanism, the semantic intent is documented here.
CREATE UNIQUE INDEX idx_support_access_grants_token_hash
  ON public.support_access_grants (token_hash);


-- ============================================================================
-- §4 — Enable Row Level Security
-- ============================================================================

-- WHY ENABLE immediately after CREATE: Postgres RLS is opt-in per table.
-- Without this, all authenticated/anon roles have unrestricted access.
-- SOC2 CC6.1: deny-by-default is the baseline access control posture.
ALTER TABLE public.support_access_grants ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- §5 — SELECT policies
-- ============================================================================

-- Policy: users can SELECT only their own grants (resource-owner visibility).
--
-- WHY this policy: users need to see what access has been requested against
-- their sessions so they can approve, deny, or revoke. Without self-access,
-- the user-facing approval page (/support/access/[grantId]) would return
-- no rows for a legitimate owner, breaking the consent UX.
--
-- WHY (SELECT auth.uid()) not auth.uid():
--   The subquery form is a Supabase-recommended pattern that forces Postgres
--   to evaluate auth.uid() once and cache it as a constant in the query plan.
--   The bare function call re-evaluates per row, causing plan re-optimization
--   on large scans. The subquery form is marginally faster and consistent with
--   every other RLS policy in the codebase (SOC2 CC6.1 / OWASP A01:2021).
--
-- SOC2 CC6.3: Users can only see grants scoped to their own sessions.
CREATE POLICY support_access_grants_select_self
  ON public.support_access_grants
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Policy: site admins can SELECT all grant rows.
--
-- WHY admins need full SELECT: the admin support console must display all
-- pending/approved/revoked grants across all users to manage support workflows.
-- An admin who created a grant must also be able to see its current status
-- (approved vs. revoked by user) to know whether to attempt a consume.
--
-- WHY is_site_admin (not a self-join on site_admins):
--   is_site_admin() is a SECURITY DEFINER function (migration 040) that
--   encapsulates the site_admins lookup. Using it here is consistent with
--   all other admin RLS policies in the codebase and centralizes the
--   "is this person an admin?" logic in one place (DRY, auditable).
--
-- WHY (SELECT auth.uid()) — same cache-constant reason as above.
--
-- SOC2 CC6.1: Admin access is gated on is_site_admin(); not granted to all
--   authenticated users. OWASP A01:2021: function-level access control.
CREATE POLICY support_access_grants_select_admin
  ON public.support_access_grants
  FOR SELECT
  TO authenticated
  USING (public.is_site_admin((SELECT auth.uid())));

-- ============================================================================
-- NO INSERT / UPDATE / DELETE POLICIES
-- ============================================================================
-- WHY: All mutations flow through SECURITY DEFINER wrappers in migration 049
-- (T2). The wrappers enforce:
--   - Authorization (is_site_admin for admin ops, self-ownership for user ops)
--   - Token hash validation (timingSafeEqual in Node, hash-only in DB)
--   - Atomic view-count increment with FOR UPDATE row lock (prevents TOCTOU)
--   - Audit log writes to admin_audit_log within the same transaction
-- Exposing INSERT/UPDATE/DELETE via RLS policies would allow callers to bypass
-- these invariants. The absence of DML policies + explicit REVOKE below is the
-- architectural enforcement of T2 as the only mutation path.


-- ============================================================================
-- §6 — Grant / Revoke DML privileges
-- ============================================================================

-- REVOKE UPDATE and DELETE from all app roles.
--
-- WHY REVOKE explicitly (not just rely on no UPDATE/DELETE policy):
--   Postgres RLS policies are evaluated only when the role has the underlying
--   table privilege. If UPDATE were never granted, an attempt raises 42501
--   (insufficient_privilege) before RLS is even checked — a cleaner, earlier
--   rejection. More importantly, if a future migration accidentally GRANTs
--   UPDATE to authenticated, an accidental UPDATE policy would be the only
--   remaining barrier. The explicit REVOKE here is defense-in-depth:
--   a future grant regression would still be blocked at the privilege layer.
--   Pattern mirrors admin_audit_log in migration 040 (line 202).
--
-- WHY also REVOKE INSERT: INSERT is not granted to any app role at all, but
--   explicitly revoking it documents that this is intentional — a reader
--   reviewing the migration must not wonder "why is there no INSERT policy?".
--
-- SOC2 CC6.1: Least privilege — app roles cannot directly mutate grants.
-- OWASP A01:2021: Defense-in-depth; privilege layer denies before policy layer.
REVOKE INSERT, UPDATE, DELETE ON public.support_access_grants
  FROM PUBLIC, authenticated, anon;

-- Grant service_role full access (webhooks, scheduled jobs, admin tooling).
-- service_role bypasses RLS by default in Supabase; this GRANT ensures the
-- role can also execute DML without hitting the REVOKE above.
GRANT ALL ON public.support_access_grants TO service_role;

-- Grant service_role access to the bigserial sequence (required for INSERT
-- from SECURITY DEFINER wrappers that run as service_role-equivalent caller).
-- WHY: GRANT ALL ON TABLE does not automatically grant on sequences in Postgres.
-- Without this, nextval('support_access_grants_id_seq') inside the wrapper
-- would raise 42501 if the wrapper's SECURITY DEFINER context is postgres
-- but the caller is authenticated.
GRANT ALL ON SEQUENCE public.support_access_grants_id_seq TO service_role;


-- ============================================================================
-- Migration 048 complete.
-- ============================================================================
--
-- NEXT STEPS (migration 049 — T2):
--   admin_request_support_access(p_ticket_id, p_user_id, p_session_id, p_reason, p_expires_in_hours)
--   user_approve_support_access(p_grant_id)
--   user_revoke_support_access(p_grant_id)
--   admin_consume_support_access(p_token_hash)  -- atomic FOR UPDATE + count increment
--
-- VERIFICATION:
--   Docker unavailable locally. CI gates via Phase 4.0 workflow:
--   supabase db reset → applies migrations 001..048 → runs pgTAP tests.
--   Local verification gap documented in .subagent-dev-reports/tasks/task-01-implementer.md.
-- ============================================================================
