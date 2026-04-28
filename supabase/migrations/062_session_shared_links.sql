-- Migration 062: Create session_shared_links table
--
-- WHY this table is needed: The session sharing feature (Power+ tier) allows
-- users to create public share links for their session transcripts. These links
-- provide scoped, read-only access to encrypted session messages and are
-- controlled by expiry timestamps and max-access counts.
--
-- This table was referenced in the codebase (4 routes + account deletion +
-- account export) since Phase 7 Batch 2 but was never accompanied by a CREATE
-- TABLE migration. The H26 drift audit surfaced the gap.
--
-- Columns inferred from the following code references:
--   - packages/styrby-web/src/app/api/sessions/[id]/share/route.ts  (INSERT)
--   - packages/styrby-web/src/app/api/shared/[shareId]/route.ts     (SELECT, UPDATE)
--   - packages/styrby-web/src/app/api/account/delete/route.ts        (DELETE)
--   - packages/styrby-web/src/app/api/account/export/route.ts        (SELECT *)
--   - packages/styrby-shared/src/types.ts (SharedSession interface)
--
-- ROLLBACK: DROP TABLE public.session_shared_links;
--
-- Risk class: SAFE — net-new table, no existing rows, no ALTER on live table.
-- ============================================================================

-- ============================================================================
-- §1. Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.session_shared_links (
  -- Primary identifier: short URL-safe alphanumeric string (12 chars, nanoid-style).
  -- WHY TEXT not UUID: share IDs appear in public URLs and must be short and
  -- human-friendly. UUIDs are too long for a clean /shared/abc123xyz456 URL.
  share_id        TEXT        PRIMARY KEY,

  -- FK to sessions. The shared content lives in the sessions + session_messages
  -- tables; this record is the access-control gate.
  session_id      UUID        NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,

  -- The authenticated user who created this share link.
  -- WHY 'shared_by' not 'user_id': The column name was chosen at the application
  -- layer to be semantically clear — the owner is the one who shared the session.
  -- See account/delete/route.ts comment: "Uses 'shared_by' (not 'user_id')".
  shared_by       UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Optional expiry. NULL means the link never expires.
  -- When set, the share API returns 410 Gone after this timestamp.
  expires_at      TIMESTAMPTZ,

  -- Optional max access cap. NULL means unlimited access.
  max_accesses    INTEGER     CHECK (max_accesses IS NULL OR max_accesses > 0),

  -- Monotonically increasing access counter.
  -- Incremented atomically (optimistic concurrency) on each valid view.
  -- WHY: Bounded-access links use this to enforce single-view semantics.
  access_count    INTEGER     NOT NULL DEFAULT 0 CHECK (access_count >= 0),

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.session_shared_links IS
  'Public share links for session transcripts. Access controlled by expiry and max-view count. Power+ tier feature.';

COMMENT ON COLUMN public.session_shared_links.share_id IS
  '12-char URL-safe nanoid. Appears in /shared/:shareId public URL.';
COMMENT ON COLUMN public.session_shared_links.shared_by IS
  'User who created the link. Not exposed in the public share response (IDOR mitigation).';
COMMENT ON COLUMN public.session_shared_links.access_count IS
  'Incremented atomically via optimistic-concurrency UPDATE on each successful access.';

-- ============================================================================
-- §2. Indexes
-- ============================================================================

-- Lookups by session owner — used in account/delete and account/export routes.
CREATE INDEX IF NOT EXISTS idx_session_shared_links_shared_by
  ON public.session_shared_links (shared_by);

-- Lookups by session — used if we ever add "list shares for a session".
CREATE INDEX IF NOT EXISTS idx_session_shared_links_session_id
  ON public.session_shared_links (session_id);

-- ============================================================================
-- §3. updated_at trigger
-- ============================================================================

-- Reuse the update_updated_at() trigger function established in migration 001.
-- WHY: Consistent pattern across all tables; avoids duplicate trigger bodies.
CREATE OR REPLACE TRIGGER set_session_shared_links_updated_at
  BEFORE UPDATE ON public.session_shared_links
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- §4. Row-Level Security
-- ============================================================================

ALTER TABLE public.session_shared_links ENABLE ROW LEVEL SECURITY;

-- Policy: authenticated users can SELECT their own share links only.
-- WHY: The public share viewer endpoint uses the service_role key (bypasses RLS)
-- to look up the share record by share_id. Regular user queries are scoped.
CREATE POLICY "session_shared_links: owner select"
  ON public.session_shared_links
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = shared_by);

-- Policy: authenticated users can INSERT share links they own.
CREATE POLICY "session_shared_links: owner insert"
  ON public.session_shared_links
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = shared_by);

-- Policy: authenticated users can UPDATE (e.g. revoke) their own share links.
-- The access_count increment from the public endpoint uses service_role, which
-- bypasses RLS — this policy is only for owner-initiated mutations.
CREATE POLICY "session_shared_links: owner update"
  ON public.session_shared_links
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = shared_by);

-- Policy: authenticated users can DELETE their own share links.
CREATE POLICY "session_shared_links: owner delete"
  ON public.session_shared_links
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = shared_by);

-- ============================================================================
-- §5. Grant
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.session_shared_links
  TO authenticated;

-- service_role needs access for:
--  (a) public share viewer endpoint (SELECT by share_id, no auth context)
--  (b) access_count atomic increment (UPDATE without user JWT)
GRANT SELECT, UPDATE
  ON public.session_shared_links
  TO service_role;
