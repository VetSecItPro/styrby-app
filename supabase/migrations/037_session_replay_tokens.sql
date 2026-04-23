-- Migration 037: Session Replay Tokens — privacy-preserving session playback (Phase 3.3)
--
-- WHY: Users leave AI agents running overnight and need to review what happened.
-- Raw session_messages are E2E-encrypted with device keys, so we cannot grant
-- public read access directly. Instead we issue one-time signed tokens that:
--   1. Are validated server-side (hash comparison, expiry, view count)
--   2. Grant temporary service-role read access scoped to one session
--   3. Apply a configurable scrub mask before any content crosses the wire
--
-- The raw token is ONLY in the URL — we store only the SHA-256 hash.
-- This means a database breach cannot replay existing links.
--
-- SOC2 CC7.2: Shared session access is a controlled disclosure event.
--   Every view increments views_used and is audit-logged with viewer_ip_hash.
--   Tokens can be revoked at any time (revoked_at IS NOT NULL → 410 Gone).
--   Tokens auto-expire (expires_at) and burn after N views (max_views).
--
-- GDPR Art. 5(1)(c) / Data minimisation: scrub_mask lets the token creator
--   redact secrets, file paths, and shell commands before the viewer sees them.
--   The scrubbed output is generated server-side and never stored.

-- ============================================================================
-- session_replay_tokens table
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_replay_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The session this token grants replay access to.
  -- Cascade-delete so orphaned tokens never persist after session removal.
  session_id    UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- The user who created (and can revoke) this token.
  -- WHY profiles not auth.users: profiles is our app-level identity table;
  -- using it here keeps FK semantics consistent with the rest of the schema.
  created_by    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- SHA-256 hex digest of the raw URL token.
  -- WHY store hash not raw: If the database is breached, stored hashes cannot
  -- be replayed as valid replay URLs. The raw token exists only in the signed
  -- URL handed to the creator.
  token_hash    TEXT        UNIQUE NOT NULL,

  -- Token lifetime. Default 24 hours; creator can choose 1h/24h/7d/30d.
  -- WHY configurable: A "quick share" for a colleague's review differs from
  -- archiving a session for a quarterly audit.
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',

  -- Maximum number of views before the token is auto-burned.
  -- NULL = unlimited. Default 10 protects against accidental wide distribution.
  max_views     INTEGER     DEFAULT 10 CHECK (max_views IS NULL OR max_views > 0),

  -- Monotonically-increasing view counter. Atomically incremented per view
  -- to enforce max_views without races (UPDATE ... WHERE views_used < max_views).
  views_used    INTEGER     NOT NULL DEFAULT 0 CHECK (views_used >= 0),

  -- Scrub mask controlling which message fields to redact server-side.
  -- Schema: { secrets: boolean, file_paths: boolean, commands: boolean }
  -- WHY JSONB: forward-compatible — new mask fields can be added without
  -- a schema migration, and the application layer validates the shape.
  scrub_mask    JSONB       NOT NULL DEFAULT '{"secrets":true,"file_paths":false,"commands":false}'::jsonb,

  -- Set by the owner to immediately revoke a token before it naturally expires.
  -- Checked server-side before every view; revoked tokens return 410 Gone.
  revoked_at    TIMESTAMPTZ,

  -- Audit trail — when this token was first created.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraint: views_used cannot exceed max_views (enforced in app too, but
  -- belt-and-suspenders at the DB layer).
  CONSTRAINT replay_token_views_within_limit
    CHECK (max_views IS NULL OR views_used <= max_views)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Primary lookup path: validate a URL token → hash it → find this row.
-- UNIQUE constraint already creates an index, but a named partial index on
-- non-revoked, non-expired tokens lets Postgres skip dead rows in the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_tokens_hash
  ON session_replay_tokens(token_hash)
  WHERE revoked_at IS NULL;

-- Per-session listing: "show all active replay links I created for session X".
CREATE INDEX IF NOT EXISTS idx_replay_tokens_session_id
  ON session_replay_tokens(session_id);

-- Per-creator listing: "show all replay tokens I created" (for the manage UI).
CREATE INDEX IF NOT EXISTS idx_replay_tokens_created_by
  ON session_replay_tokens(created_by, created_at DESC);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE session_replay_tokens ENABLE ROW LEVEL SECURITY;

-- WHY SELECT policy scoped to created_by: Replay viewers are unauthenticated
-- (anyone with the URL can view). Server-side validation uses service-role
-- (bypasses RLS) AFTER timing-safe hash verification. The SELECT policy here
-- only covers the "manage your own tokens" dashboard view.
CREATE POLICY "replay_tokens: creator can select own" ON session_replay_tokens
  FOR SELECT USING (created_by = (SELECT auth.uid()));

CREATE POLICY "replay_tokens: creator can insert own" ON session_replay_tokens
  FOR INSERT WITH CHECK (created_by = (SELECT auth.uid()));

-- WHY UPDATE limited to revoked_at only: Creators can revoke tokens (set
-- revoked_at = NOW()) but cannot alter token_hash, views_used, or scrub_mask
-- after creation. This is enforced at the application layer; the DB policy
-- only restricts who can issue the UPDATE at all.
CREATE POLICY "replay_tokens: creator can update own" ON session_replay_tokens
  FOR UPDATE USING (created_by = (SELECT auth.uid()));

-- Soft deletes via revoked_at preferred, but allow hard DELETE for cleanup.
CREATE POLICY "replay_tokens: creator can delete own" ON session_replay_tokens
  FOR DELETE USING (created_by = (SELECT auth.uid()));
