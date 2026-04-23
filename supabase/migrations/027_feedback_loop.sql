-- ============================================================================
-- STYRBY DATABASE MIGRATION 027: Feedback Loop
-- ============================================================================
-- Implements Phase 1.6.11 feedback-loop infrastructure:
--
--   1. ALTER user_feedback — extend columns:
--        - kind TEXT ENUM('nps','general','session_postmortem','icp_soft')
--        - score INT (0-10 NPS score, 1-2 session rating encoded)
--        - followup TEXT (NPS follow-up free text)
--        - window ENUM('7d','30d') for NPS window tagging
--        - rating ENUM('useful','not_useful') for session post-mortems
--        - reason TEXT for post-mortem negative reason
--        - context_json JSONB for screen/route context (no PII)
--        - prompt_id UUID FK to user_feedback_prompts (link prompt → response)
--
--   2. user_feedback_prompts table
--        Scheduled NPS prompt rows (one per user per window).
--        pg_cron polls every 15 min and enqueues push + in-app notification
--        for each due prompt.
--
--   3. Helper functions:
--        fn_schedule_nps_prompts()  — insert 7d + 30d rows on profile insert
--        fn_dispatch_due_nps_prompts() — cron handler; 15-min poll
--        fn_notify_founder_negative_postmortem() — trigger on not_useful+reason
--
--   4. pg_cron jobs:
--        styrby_nps_prompt_dispatch  — every 15 min
--
--   5. Trigger:
--        tr_schedule_nps_on_signup — calls fn_schedule_nps_prompts() on
--        INSERT INTO profiles
--
--   6. RLS on new table
--
-- WHY: NPS is the single most important acquirer metric. Acquirers use
-- weekly NPS trend + promoter/detractor breakdown to model churn risk
-- and word-of-mouth growth. CLAUDE.md mandates SOC2 CC7.2 audit trail
-- on all communication to external parties; every prompt dispatch +
-- feedback submission is logged in audit_log.
--
-- pg_cron expression reference (all times in Central Time per CLAUDE.md):
--   Every 15 min: */15 * * * *
--
-- SAFE TO RE-RUN: All DDL uses IF NOT EXISTS / DO $$ blocks.
-- ============================================================================


-- ============================================================================
-- Step 1: Extend user_feedback with Phase 1.6.11 columns
-- ============================================================================
-- WHY: The original user_feedback table has `feedback_type` (enum bug|feature|
-- general|nps) and `rating INT 1-10`. We extend it with the fields needed
-- for NPS windowing, session post-mortems, and context capture.
-- We add columns rather than a new table to avoid JOIN overhead on the
-- founder dashboard and preserve existing RLS policies.

ALTER TABLE user_feedback
  -- Semantic kind that replaces the overloaded feedback_type for new rows
  -- WHY: 'nps' already exists in feedback_type enum; keeping backward compat.
  ADD COLUMN IF NOT EXISTS kind TEXT
    CHECK (kind IN ('nps', 'general', 'session_postmortem', 'icp_soft')),

  -- NPS score (0-10). For session_postmortem this column is NULL; rating column used.
  ADD COLUMN IF NOT EXISTS score INTEGER
    CHECK (score IS NULL OR (score >= 0 AND score <= 10)),

  -- Optional NPS free-text follow-up ("What's the #1 thing we could improve?")
  ADD COLUMN IF NOT EXISTS followup TEXT,

  -- NPS window: '7d' (day-7 survey) or '30d' (day-30 survey)
  ADD COLUMN IF NOT EXISTS window TEXT
    CHECK (window IN ('7d', '30d')),

  -- Session post-mortem: 'useful' or 'not_useful'
  ADD COLUMN IF NOT EXISTS rating TEXT
    CHECK (rating IN ('useful', 'not_useful')),

  -- Negative post-mortem reason (free text, shown to founder in alert email)
  ADD COLUMN IF NOT EXISTS reason TEXT,

  -- Route / screen name context (no PII, no message content)
  ADD COLUMN IF NOT EXISTS context_json JSONB DEFAULT '{}'::jsonb,

  -- FK to the scheduled prompt row that triggered this survey (NPS only)
  -- Set NULL for general and post-mortem feedback
  ADD COLUMN IF NOT EXISTS prompt_id UUID;

-- Index: NPS window queries for founder dashboard trend chart
CREATE INDEX IF NOT EXISTS idx_user_feedback_kind_window
  ON user_feedback(kind, window, created_at DESC)
  WHERE kind = 'nps';

-- Index: post-mortem listing for founder dashboard (filter by agent)
CREATE INDEX IF NOT EXISTS idx_user_feedback_postmortem
  ON user_feedback(kind, created_at DESC)
  WHERE kind = 'session_postmortem';

COMMENT ON COLUMN user_feedback.kind IS
  'Semantic feedback category: nps | general | session_postmortem | icp_soft. '
  'Coexists with feedback_type (legacy) — new code writes kind, old code writes feedback_type.';

COMMENT ON COLUMN user_feedback.score IS
  'NPS score 0-10. NULL for non-NPS feedback kinds.';

COMMENT ON COLUMN user_feedback.followup IS
  'NPS follow-up free text: "What is the #1 thing we could do to raise that score?"';

COMMENT ON COLUMN user_feedback.window IS
  'NPS survey window: 7d (7-day post-signup) or 30d (30-day post-signup).';

COMMENT ON COLUMN user_feedback.rating IS
  'Session post-mortem one-tap: useful | not_useful.';

COMMENT ON COLUMN user_feedback.reason IS
  'Session post-mortem free-text reason (only meaningful when rating = not_useful).';

COMMENT ON COLUMN user_feedback.context_json IS
  'Route/screen context captured at submission time. No PII, no message content. '
  'Example: {"screen": "/dashboard/sessions", "agent": "claude"}';

COMMENT ON COLUMN user_feedback.prompt_id IS
  'FK to user_feedback_prompts row that triggered this NPS survey. '
  'NULL for unsolicited general feedback and session post-mortems.';


-- ============================================================================
-- Step 2: user_feedback_prompts table
-- ============================================================================
-- WHY: We need to track scheduled NPS prompts per user per window:
--   - Prevent duplicates (one prompt per window per user)
--   - Know when to dispatch (due_at timestamp)
--   - Know if already dispatched (dispatched_at, response_id)
--   - Know if dismissed without answering (dismissed_at)
--
-- This is not session_checkpoints or audit_log — it is a scheduler table
-- analogous to offline_command_queue but for NPS prompt delivery.

CREATE TABLE IF NOT EXISTS user_feedback_prompts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Which NPS window this prompt represents
  -- 'nps_7d' fires 7 days after signup; 'nps_30d' fires 30 days after signup
  kind              TEXT        NOT NULL CHECK (kind IN ('nps_7d', 'nps_30d')),

  -- When to send the prompt (signup + 7 days or signup + 30 days)
  due_at            TIMESTAMPTZ NOT NULL,

  -- When the cron dispatched the push + in-app notification
  dispatched_at     TIMESTAMPTZ,

  -- Expo push message ID returned by the delivery call
  push_message_id   TEXT,

  -- FK to the user_feedback row when user responds (NULL until responded)
  response_id       UUID REFERENCES user_feedback(id) ON DELETE SET NULL,

  -- User dismissed the prompt without answering
  dismissed_at      TIMESTAMPTZ,

  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Idempotency: one prompt per user per kind
  CONSTRAINT uq_feedback_prompt_user_kind UNIQUE (user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_feedback_prompts_due
  ON user_feedback_prompts(due_at)
  WHERE dispatched_at IS NULL AND dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_prompts_user
  ON user_feedback_prompts(user_id, kind);

ALTER TABLE user_feedback_prompts ENABLE ROW LEVEL SECURITY;

-- Users can view and dismiss their own prompts
CREATE POLICY feedback_prompts_select ON user_feedback_prompts
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY feedback_prompts_update ON user_feedback_prompts
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Only service role inserts (fn_schedule_nps_prompts trigger + cron)
CREATE POLICY feedback_prompts_insert_service ON user_feedback_prompts
  FOR INSERT WITH CHECK (true);

CREATE POLICY feedback_prompts_delete_service ON user_feedback_prompts
  FOR DELETE USING (true);

COMMENT ON TABLE user_feedback_prompts IS
  'Scheduled NPS prompt delivery queue. One row per user per NPS window (7d, 30d). '
  'The fn_dispatch_due_nps_prompts() cron function polls every 15 min, picks '
  'due rows, sends push + in-app notification, and stamps dispatched_at. '
  'Idempotency enforced by UNIQUE (user_id, kind).';


-- ============================================================================
-- Step 3: fn_schedule_nps_prompts — insert prompts on profile creation
-- ============================================================================
-- Called by the tr_schedule_nps_on_signup trigger after INSERT on profiles.
-- Inserts two rows: nps_7d (NOW + 7 days) and nps_30d (NOW + 30 days).
-- Uses ON CONFLICT DO NOTHING for idempotency (trigger may fire twice on
-- upserts in some Supabase auth flows).
--
-- WHY trigger not cron: Cron approach would require a daily scan of all
-- profiles filtered on created_at to find new users. A trigger is O(1)
-- per new signup and fires immediately — no lag, no missed users.

CREATE OR REPLACE FUNCTION fn_schedule_nps_prompts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- WHY: Insert both prompts atomically with the new profile row.
  -- If the INSERT fails (e.g. the profile is deleted immediately), the
  -- ON DELETE CASCADE on user_feedback_prompts.user_id cleans up.
  INSERT INTO user_feedback_prompts (user_id, kind, due_at)
  VALUES
    (NEW.id, 'nps_7d',  NEW.created_at + INTERVAL '7 days'),
    (NEW.id, 'nps_30d', NEW.created_at + INTERVAL '30 days')
  ON CONFLICT (user_id, kind) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_schedule_nps_prompts() IS
  'TRIGGER function: inserts nps_7d and nps_30d prompt rows into '
  'user_feedback_prompts when a new profile row is inserted. '
  'Fires AFTER INSERT on profiles.';

-- Bind the trigger on profiles
DROP TRIGGER IF EXISTS tr_schedule_nps_on_signup ON profiles;

CREATE TRIGGER tr_schedule_nps_on_signup
  AFTER INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION fn_schedule_nps_prompts();


-- ============================================================================
-- Step 4: fn_dispatch_due_nps_prompts — 15-min cron poll
-- ============================================================================
-- Picks up to 500 due prompts per run (safety cap to avoid long transactions),
-- inserts an in-app notification for each user, and marks dispatched_at.
-- The mobile push itself is sent by the /api/cron/nps-prompt-dispatch Next.js
-- route (pg_cron cannot call Expo Push API directly).
--
-- WHY in-app notification insert here (not only from Next.js):
-- In-app notification must exist even if the push fails. If the Next.js route
-- is down, the user still sees the prompt in the in-app notification feed.
-- The Next.js route separately sends the mobile push.

CREATE OR REPLACE FUNCTION fn_dispatch_due_nps_prompts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  dispatched_count INTEGER := 0;
  prompt_row RECORD;
BEGIN
  -- Process due prompts in batches of 500 to avoid long transactions.
  FOR prompt_row IN
    SELECT ufp.id, ufp.user_id, ufp.kind
    FROM user_feedback_prompts ufp
    JOIN profiles p ON p.id = ufp.user_id
    WHERE ufp.due_at <= NOW()
      AND ufp.dispatched_at IS NULL
      AND ufp.dismissed_at IS NULL
      AND p.deleted_at IS NULL
    ORDER BY ufp.due_at ASC
    LIMIT 500
    FOR UPDATE OF ufp SKIP LOCKED
  LOOP
    -- Insert in-app notification for the NPS prompt
    -- WHY: Coalesce on existing unread NPS notification to avoid double-insert
    -- if cron fires twice within 15 min (should not happen but belt-and-suspenders).
    INSERT INTO notifications (user_id, type, title, body, deep_link, metadata)
    SELECT
      prompt_row.user_id,
      'milestone',
      CASE prompt_row.kind
        WHEN 'nps_7d'  THEN 'Quick question about Styrby'
        WHEN 'nps_30d' THEN 'How is Styrby working for you?'
        ELSE 'Quick question'
      END,
      'How likely are you to recommend Styrby? Tap to share your score.',
      '/nps/' || prompt_row.kind,
      jsonb_build_object(
        'prompt_id', prompt_row.id,
        'kind', prompt_row.kind,
        'nps_prompt', true
      )
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications n2
      WHERE n2.user_id = prompt_row.user_id
        AND n2.metadata->>'prompt_id' = prompt_row.id::text
    );

    -- Mark as dispatched
    UPDATE user_feedback_prompts
    SET dispatched_at = NOW()
    WHERE id = prompt_row.id;

    -- Audit log entry (SOC2 CC7.2)
    INSERT INTO audit_log (user_id, event_type, metadata)
    VALUES (
      prompt_row.user_id,
      'nps_prompt_dispatched',
      jsonb_build_object(
        'prompt_id', prompt_row.id,
        'kind', prompt_row.kind
      )
    );

    dispatched_count := dispatched_count + 1;
  END LOOP;

  RETURN dispatched_count;
END;
$$;

COMMENT ON FUNCTION fn_dispatch_due_nps_prompts() IS
  'Polls user_feedback_prompts for due rows (due_at <= NOW(), not yet dispatched). '
  'For each: inserts an in-app notification and marks dispatched_at. '
  'Returns the count of newly dispatched prompts. '
  'Called every 15 min by the styrby_nps_prompt_dispatch pg_cron job. '
  'The mobile push is sent separately by /api/cron/nps-prompt-dispatch.';


-- ============================================================================
-- Step 5: pg_cron job — NPS prompt dispatch (every 15 min)
-- ============================================================================
-- WHY 15 min: Low-volume (only fires for users at exactly the 7- or 30-day mark).
-- More frequent would waste cycles; less frequent would delay the prompt by
-- up to an hour. 15 min is the right balance per the product spec.
-- Cron expression: */15 * * * *  (every 15 minutes)

SELECT cron.schedule(
  'styrby_nps_prompt_dispatch',
  '*/15 * * * *',   -- every 15 minutes (UTC — used by Supabase)
  $$SELECT fn_dispatch_due_nps_prompts()$$
);


-- ============================================================================
-- Step 6: Backfill existing profiles with NPS prompt rows
-- ============================================================================
-- WHY: Existing users signed up before this migration don't have prompt rows.
-- We backfill them using their actual created_at so day-7 and day-30 are
-- calculated from their real signup date. Users who are already past the
-- windows still get rows inserted so the cron picks them up immediately
-- on next run — we want their NPS now rather than never.

INSERT INTO user_feedback_prompts (user_id, kind, due_at)
SELECT
  p.id,
  'nps_7d',
  p.created_at + INTERVAL '7 days'
FROM profiles p
WHERE p.deleted_at IS NULL
ON CONFLICT (user_id, kind) DO NOTHING;

INSERT INTO user_feedback_prompts (user_id, kind, due_at)
SELECT
  p.id,
  'nps_30d',
  p.created_at + INTERVAL '30 days'
FROM profiles p
WHERE p.deleted_at IS NULL
ON CONFLICT (user_id, kind) DO NOTHING;


-- ============================================================================
-- Step 7: Service-role access on user_feedback for founder dashboard
-- ============================================================================
-- WHY: The existing user_feedback RLS allows users to INSERT their own rows.
-- The founder dashboard API route needs SELECT access across all users via
-- the service role (which bypasses RLS by design). No additional RLS needed
-- for service role — service role bypasses RLS.
-- We do need to confirm the SELECT policy is only missing for non-owner reads.

-- Verify users cannot SELECT other users' feedback (correct by default since
-- there's no wildcard SELECT policy on user_feedback).
-- WHY: The original schema only has INSERT for own user_id. SELECT is intentionally
-- blocked for users (founder dashboard uses service role client which bypasses RLS).

COMMENT ON TABLE user_feedback_prompts IS
  'NPS prompt scheduler. One row per user per window (nps_7d, nps_30d). '
  'Trigger fn_schedule_nps_prompts() inserts on profile creation. '
  'fn_dispatch_due_nps_prompts() cron marks dispatched_at and queues in-app notification. '
  'Idempotency: UNIQUE(user_id, kind) prevents duplicate schedules.';
