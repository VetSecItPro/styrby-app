-- Migration: 079_digest_summaries
-- Stream B: Session-summarization feature
--
-- Creates the digest_summaries table that stores AI-generated periodic
-- digests (daily for Growth, weekly for Pro+Growth) of each user's
-- coding sessions. The /api/cron/generate-digest route writes to this
-- table; the dashboard "Today" panel reads from it.
--
-- Idempotency: UNIQUE (user_id, period, period_start) prevents duplicate
-- digests if the cron retries or fires twice in the same window.

CREATE TABLE digest_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  -- AI-generated digest text (2-3 sentence narrative).
  -- Nullable so we can record an attempt even if the LLM call fails.
  content TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  -- NULL = email not yet sent. Set after successful Resend dispatch.
  emailed_at TIMESTAMPTZ,
  UNIQUE (user_id, period, period_start)
);

-- Covers the dashboard "most recent digest" query path:
--   SELECT ... FROM digest_summaries WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1
CREATE INDEX idx_digest_summaries_user_recent
  ON digest_summaries(user_id, generated_at DESC);

ALTER TABLE digest_summaries ENABLE ROW LEVEL SECURITY;

-- Users can read their own digests. WHY (SELECT auth.uid()) wrapping:
-- forces the planner to evaluate auth.uid() once per query (init-plan)
-- instead of once per row, materially faster on large tables.
CREATE POLICY "users read own digests"
  ON digest_summaries
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- No INSERT/UPDATE/DELETE policy on purpose: only the service role
-- (cron + email worker) writes here, and service_role bypasses RLS.
-- anon and authenticated remain default-deny for writes.

COMMENT ON TABLE digest_summaries IS
  'AI-generated periodic digests of user sessions. Written by /api/cron/generate-digest, read by dashboard digest panel.';
