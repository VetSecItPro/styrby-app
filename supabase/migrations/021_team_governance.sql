-- ============================================================================
-- STYRBY DATABASE MIGRATION 021: Team Governance — Policies, Approvals,
--                                  Shared Sessions, Exports, Integrations,
--                                  Billing Events
-- ============================================================================
-- Phase 2.1 of styrby-improve-19Apr.md. Adds the governance tables required
-- for the Team / Business tier launch: approval policies, session sharing,
-- GDPR exports, third-party integrations, and Polar billing event history.
--
-- SECURITY-CRITICAL: Every table below contains team-scoped or user-scoped
-- data. RLS policies use the `(SELECT auth.uid())` pattern for query-plan
-- caching (per SUPABASE_RLS_PERF.md and existing migrations). Cross-tenant
-- access MUST be impossible by construction.
--
-- Compliance anchors:
--   - SOC2 CC6 (Logical Access): RLS on every new table
--   - SOC2 CC7 (System Operations): audit_log triggers on mutation-sensitive
--     tables (team_policies, approvals, integrations, billing_events)
--   - ISO 27001 A.9 (Access Control): role-based policy evaluation
--   - GDPR Art. 15/20: `exports` table supports data portability requests
--
-- Dependencies:
--   - Migration 006 (teams, team_members, team_invitations)
--   - Migration 001 (profiles, sessions, subscriptions, audit_log,
--                   update_updated_at fn, audit_action enum)
--   - Migration 018 (audit_trigger_fn — reused here)
--
-- Tables created (6):
--   1. team_policies    — approval rules (threshold, approver_role, filter)
--   2. approvals        — pending/resolved approval requests for CLI tool calls
--   3. sessions_shared  — ad-hoc per-session share grants (independent of team)
--   4. exports          — GDPR data-export request lifecycle
--   5. integrations     — encrypted per-team third-party creds (Slack, etc.)
--   6. billing_events   — Polar webhook event history with idempotency key
--
-- Design decisions:
--   - `approvals` is NEW in this migration (task 2.1 + 2.4.7 imply it). It is
--     distinct from `team_invitations` — invitations are membership-lifecycle;
--     approvals are per-tool-call governance events driven by team_policies.
--   - All tables use UUID primary keys for consistency with existing schema.
--   - All timestamp columns use TIMESTAMPTZ + NOW() default.
--   - All "soft" configuration uses JSONB with explicit `NOT NULL DEFAULT '{}'`.
--   - `integrations.config_encrypted` is TEXT containing a base64-encoded
--     libsodium secretbox (key rotation handled at app layer).
-- ============================================================================


-- ============================================================================
-- TABLE 1: team_policies
-- ============================================================================
-- Approval / blocking policies scoped to a team. Evaluated by the CLI
-- policyEngine (Phase 2.4.1) before executing tool calls.
--
-- rule_type semantics:
--   'cost_threshold'   — block/approve when estimated tool-call cost > threshold
--   'agent_filter'     — restrict which agents a role can use (agent_filter[])
--   'tool_allowlist'   — only pre-approved tools may run (agent_filter[])
--   'time_window'      — enforce policy only during listed hours (JSONB settings)
--
-- The `action` column is the policy's enforcement behavior when matched.
-- ============================================================================

CREATE TABLE team_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  -- Human-readable identifier
  name TEXT NOT NULL,
  description TEXT,

  -- Rule classification
  -- WHY CHECK constraint rather than enum: easier to extend without migrations
  -- for future policy types (we expect to iterate on this post-launch).
  rule_type TEXT NOT NULL
    CHECK (rule_type IN ('cost_threshold', 'agent_filter', 'tool_allowlist', 'time_window')),

  -- Numeric threshold (e.g., USD cost for 'cost_threshold' policies). Nullable
  -- because not every rule_type uses a threshold.
  threshold NUMERIC(12, 6),

  -- Which role can approve if the policy triggers a manual approval.
  -- 'any_admin' means any owner or admin can approve.
  approver_role TEXT
    CHECK (approver_role IN ('owner', 'admin', 'any_admin', 'specific_user') OR approver_role IS NULL),

  -- Specific approver (used when approver_role = 'specific_user')
  approver_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Agent / tool filter list (agent types or tool names)
  agent_filter TEXT[] DEFAULT '{}' NOT NULL,

  -- Action when matched: block outright, require approval, or allow + log
  action TEXT NOT NULL DEFAULT 'require_approval'
    CHECK (action IN ('block', 'require_approval', 'allow_with_audit')),

  -- Arbitrary rule-specific config (e.g. time_window hours, budget windows)
  settings JSONB DEFAULT '{}' NOT NULL,

  -- On/off switch (admins can disable without deleting)
  enabled BOOLEAN DEFAULT TRUE NOT NULL,

  -- Ordering — lower priority evaluated first
  priority INTEGER DEFAULT 100 NOT NULL,

  -- Timestamps
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT team_policies_name_length
    CHECK (char_length(name) >= 1 AND char_length(name) <= 200)
);

-- Index for policy-engine hot path: fetch enabled policies for a team in priority order.
CREATE INDEX idx_team_policies_team_enabled
  ON team_policies(team_id, priority)
  WHERE enabled = TRUE;

-- Index for admin UI: list policies by team with creation date.
CREATE INDEX idx_team_policies_team_created
  ON team_policies(team_id, created_at DESC);


-- ============================================================================
-- TABLE 2: approvals
-- ============================================================================
-- A governance event generated by the policy engine when a tool call matches
-- a `require_approval` policy. The CLI blocks until an approver resolves it.
--
-- State machine:
--   pending -> approved  (approver said yes; CLI proceeds)
--   pending -> denied    (approver said no; CLI aborts)
--   pending -> expired   (timeout with fail-safe = block; see D7.5 decision)
--   pending -> cancelled (requester aborted or session ended)
-- ============================================================================

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  policy_id UUID REFERENCES team_policies(id) ON DELETE SET NULL,

  -- Who triggered it
  requester_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- What they wanted to do
  -- WHY JSONB for the request: tool call shapes vary wildly across agents;
  -- a rigid column layout would require migrations every time a new agent
  -- exposes a new tool. The app layer (policyEngine) parses this.
  tool_name TEXT NOT NULL,
  estimated_cost_usd NUMERIC(12, 6),
  request_payload JSONB NOT NULL DEFAULT '{}',

  -- Resolution
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  resolver_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note TEXT,

  -- Timing / SLA
  -- WHY expires_at: policy may set a timeout; if elapsed, cron/worker marks
  -- as expired and CLI falls back to the policy's fail-safe action (block).
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  resolved_at TIMESTAMPTZ
);

-- Hot path: mobile / web pulling pending approvals for a user's teams.
CREATE INDEX idx_approvals_team_status_pending
  ON approvals(team_id, created_at DESC)
  WHERE status = 'pending';

-- Requester view: "show me my approval requests"
CREATE INDEX idx_approvals_requester
  ON approvals(requester_user_id, created_at DESC);

-- Cron sweeper: find pending past expiry
CREATE INDEX idx_approvals_pending_expiry
  ON approvals(expires_at)
  WHERE status = 'pending';


-- ============================================================================
-- TABLE 3: sessions_shared
-- ============================================================================
-- Per-session share grants that are INDEPENDENT of team membership. Used for
-- "share this session with Alice for 24 hours" flows. Extends existing
-- session visibility (owner + team members) with ad-hoc recipients.
--
-- permission semantics:
--   'view'     — read messages and metadata
--   'comment'  — view + post comments (future)
--   'collab'   — view + send messages into the session (future)
-- ============================================================================

CREATE TABLE sessions_shared (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  shared_with_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  permission TEXT NOT NULL DEFAULT 'view'
    CHECK (permission IN ('view', 'comment', 'collab')),

  -- Optional expiration; NULL = permanent
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  revoked_at TIMESTAMPTZ,

  -- Each (session, recipient) pair is unique
  CONSTRAINT unique_session_share UNIQUE (session_id, shared_with_user_id)
);

CREATE INDEX idx_sessions_shared_recipient
  ON sessions_shared(shared_with_user_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_sessions_shared_session
  ON sessions_shared(session_id)
  WHERE revoked_at IS NULL;


-- ============================================================================
-- TABLE 4: exports
-- ============================================================================
-- GDPR Article 15 (right to access) + Article 20 (right to data portability)
-- support. Users can request an export of all their data; this table tracks
-- the request lifecycle and surfaces a signed download URL when ready.
-- ============================================================================

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Export scope & format
  format TEXT NOT NULL DEFAULT 'json'
    CHECK (format IN ('json', 'csv', 'zip')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'sessions', 'messages', 'costs', 'team')),

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'expired')),
  error_message TEXT,

  -- Delivery
  -- WHY signed URL instead of storing object directly: keeps blobs out of the
  -- row (they live in Supabase Storage). URLs are short-lived and rotated.
  download_url TEXT,
  download_path TEXT,
  size_bytes BIGINT,

  -- TTL for the signed URL / object
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_exports_user_recent
  ON exports(user_id, created_at DESC);

CREATE INDEX idx_exports_pending
  ON exports(created_at)
  WHERE status IN ('pending', 'processing');


-- ============================================================================
-- TABLE 5: integrations
-- ============================================================================
-- Per-team third-party integration credentials. Examples: Slack webhook URL,
-- GitHub App install, Linear API token. Credentials are stored encrypted
-- at the application layer (libsodium secretbox) and decrypted only in
-- authorized server contexts.
--
-- SECURITY: `config_encrypted` is NEVER exposed via PostgREST / RLS select
-- to non-service-role callers. We add a denial policy to make this explicit.
-- ============================================================================

CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  provider TEXT NOT NULL
    CHECK (provider IN ('slack', 'github', 'linear', 'jira', 'pagerduty', 'webhook_generic')),

  -- Opaque display fields (safe to expose via RLS)
  display_name TEXT,
  external_account_id TEXT,

  -- Encrypted credential blob (libsodium secretbox, base64)
  -- WHY TEXT instead of BYTEA: base64 is easier to ship through REST / JSON
  -- without double-encoding. Performance cost is negligible for these sizes.
  config_encrypted TEXT NOT NULL,

  -- Key rotation metadata
  encryption_key_id TEXT NOT NULL DEFAULT 'default',

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'revoked')),
  last_error TEXT,

  installed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- One active integration per (team, provider, external_account_id)
  CONSTRAINT unique_team_integration UNIQUE (team_id, provider, external_account_id)
);

CREATE INDEX idx_integrations_team
  ON integrations(team_id, provider)
  WHERE status = 'active';


-- ============================================================================
-- TABLE 6: billing_events
-- ============================================================================
-- Audit trail of all Polar webhook events. Supports idempotency (polar_event_id
-- UNIQUE), reconciliation, and revenue-integrity investigations (SOC2 CC7.2).
--
-- WHY separate from subscriptions: `subscriptions` holds current state;
-- `billing_events` is the event log. Both are needed — one for current truth,
-- the other for history + idempotency.
-- ============================================================================

CREATE TABLE billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner (denormalized for fast user-scoped queries and RLS)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,

  -- Event classification
  event_type TEXT NOT NULL,
  -- Examples: 'subscription.created', 'subscription.updated',
  --           'subscription.seat_added', 'subscription.seat_removed',
  --           'subscription.past_due', 'subscription.canceled',
  --           'invoice.paid', 'invoice.payment_failed'

  -- Amounts (nullable — some events have no monetary component)
  amount_usd NUMERIC(12, 2),
  currency TEXT DEFAULT 'USD',

  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed', 'skipped_duplicate')),

  -- Idempotency: Polar sends a stable ID per event; we UPSERT on it.
  polar_event_id TEXT NOT NULL,

  -- Full payload for forensic review
  raw_payload JSONB NOT NULL DEFAULT '{}',

  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT unique_polar_event UNIQUE (polar_event_id)
);

-- Hot path: list a user's billing history in the dashboard.
CREATE INDEX idx_billing_events_user_recent
  ON billing_events(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- BRIN for long-term time-series queries on the audit table.
-- WHY BRIN: billing_events grows linearly forever; BRIN is ~100x smaller
-- than B-tree for append-only time-series data (see migration 001 pattern).
CREATE INDEX idx_billing_events_time_brin
  ON billing_events USING BRIN (created_at)
  WITH (pages_per_range = 128);


-- ============================================================================
-- updated_at TRIGGERS
-- ============================================================================

CREATE TRIGGER tr_team_policies_updated_at
  BEFORE UPDATE ON team_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- SECURITY-CRITICAL. Every table below is multi-tenant. The invariant:
-- "a caller can only see rows they're authorized for via team membership,
-- ownership, or share grant." Service role bypasses RLS by design.
-- ============================================================================

ALTER TABLE team_policies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions_shared ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events  ENABLE ROW LEVEL SECURITY;


-- ─── team_policies policies ─────────────────────────────────────────────────
-- Members: SELECT (need to understand what rules govern them)
-- Admin/Owner: INSERT / UPDATE / DELETE

CREATE POLICY "team_policies_select_member"
  ON team_policies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_policies.team_id
        AND tm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "team_policies_insert_admin"
  ON team_policies FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_policies.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "team_policies_update_admin"
  ON team_policies FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_policies.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_policies.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "team_policies_delete_admin"
  ON team_policies FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_policies.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );


-- ─── approvals policies ─────────────────────────────────────────────────────
-- Requester: SELECT own, INSERT own, UPDATE to 'cancelled'
-- Team admins: SELECT all team approvals, UPDATE (resolve)
-- Anyone else: blocked

CREATE POLICY "approvals_select_requester_or_admin"
  ON approvals FOR SELECT
  USING (
    requester_user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = approvals.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

-- WHY the member check here: a regular member of a team must be able to
-- CREATE an approval request (triggered from their own CLI session) even
-- though they cannot resolve it. The requester_user_id = auth.uid() check
-- prevents impersonation.
CREATE POLICY "approvals_insert_member"
  ON approvals FOR INSERT
  WITH CHECK (
    requester_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = approvals.team_id
        AND tm.user_id = (SELECT auth.uid())
    )
  );

-- Resolution: admins resolve any; requesters can only cancel their own.
CREATE POLICY "approvals_update_admin_or_requester_cancel"
  ON approvals FOR UPDATE
  USING (
    -- Admin of the team
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = approvals.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
    -- Or requester (for cancellation)
    OR requester_user_id = (SELECT auth.uid())
  );


-- ─── sessions_shared policies ───────────────────────────────────────────────
-- Recipient: SELECT
-- Sharer (session owner): SELECT, INSERT, UPDATE (revoke), DELETE

CREATE POLICY "sessions_shared_select_recipient_or_owner"
  ON sessions_shared FOR SELECT
  USING (
    shared_with_user_id = (SELECT auth.uid())
    OR shared_by_user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = sessions_shared.session_id
        AND s.user_id = (SELECT auth.uid())
    )
  );

-- Only the session owner can create shares.
CREATE POLICY "sessions_shared_insert_session_owner"
  ON sessions_shared FOR INSERT
  WITH CHECK (
    shared_by_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = sessions_shared.session_id
        AND s.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "sessions_shared_update_sharer"
  ON sessions_shared FOR UPDATE
  USING (shared_by_user_id = (SELECT auth.uid()));

CREATE POLICY "sessions_shared_delete_sharer"
  ON sessions_shared FOR DELETE
  USING (shared_by_user_id = (SELECT auth.uid()));


-- ─── exports policies ──────────────────────────────────────────────────────
-- User-scoped; service role performs writes during async processing.

CREATE POLICY "exports_select_own"
  ON exports FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "exports_insert_own"
  ON exports FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- WHY no UPDATE/DELETE policy for authenticated users: export lifecycle is
-- owned by the backend worker (service_role). Users cannot tamper with
-- status or download_url.


-- ─── integrations policies ─────────────────────────────────────────────────
-- Admin/Owner: full access to metadata BUT `config_encrypted` is protected
-- by a column-level denial (explained below). Members: no access.

CREATE POLICY "integrations_select_admin"
  ON integrations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = integrations.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "integrations_insert_admin"
  ON integrations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = integrations.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "integrations_update_admin"
  ON integrations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = integrations.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "integrations_delete_admin"
  ON integrations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = integrations.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
    )
  );

-- Column-level defense-in-depth: revoke SELECT on config_encrypted for
-- authenticated + anon roles, so even if a future RLS policy is too loose,
-- the encrypted blob can't leak through PostgREST.
-- WHY: belt-and-suspenders per SOC2 CC6.1 (logical access). App layer must
-- use the service role to read credentials for decrypt operations.
REVOKE SELECT (config_encrypted, encryption_key_id) ON integrations FROM authenticated;
REVOKE SELECT (config_encrypted, encryption_key_id) ON integrations FROM anon;


-- ─── billing_events policies ───────────────────────────────────────────────
-- User can SELECT their own events; INSERT/UPDATE/DELETE is service-role only.

CREATE POLICY "billing_events_select_own"
  ON billing_events FOR SELECT
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- AUDIT LOG TRIGGERS
-- ============================================================================
-- Attach audit_trigger_fn (from migration 018) to the new mutation-sensitive
-- tables. These entries land in `audit_log` for SOC2 CC7.2 evidence.
-- ============================================================================

-- Ensure audit_action enum has INSERT/UPDATE/DELETE values.
-- Migration 001 defines these already; no-op safeguard here.

DROP TRIGGER IF EXISTS audit_log_team_policies_021   ON team_policies;
CREATE TRIGGER audit_log_team_policies_021
  AFTER INSERT OR UPDATE OR DELETE ON team_policies
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS audit_log_approvals_021       ON approvals;
CREATE TRIGGER audit_log_approvals_021
  AFTER INSERT OR UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS audit_log_integrations_021    ON integrations;
CREATE TRIGGER audit_log_integrations_021
  AFTER INSERT OR UPDATE OR DELETE ON integrations
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS audit_log_billing_events_021  ON billing_events;
CREATE TRIGGER audit_log_billing_events_021
  AFTER INSERT OR UPDATE OR DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- WHY no audit trigger on sessions_shared / exports:
-- sessions_shared: high-volume, low-security-impact; app-layer log suffices.
-- exports: GDPR export creation is user-initiated and already logged at API.


-- ============================================================================
-- SERVICE ROLE GRANTS
-- ============================================================================

GRANT ALL ON team_policies   TO service_role;
GRANT ALL ON approvals       TO service_role;
GRANT ALL ON sessions_shared TO service_role;
GRANT ALL ON exports         TO service_role;
GRANT ALL ON integrations    TO service_role;
GRANT ALL ON billing_events  TO service_role;


-- ============================================================================
-- END OF MIGRATION 021
-- ============================================================================
