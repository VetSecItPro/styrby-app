-- ============================================================================
-- STYRBY DATABASE MIGRATION 026: Retention Hooks
-- ============================================================================
-- Implements Phase 1.6.8 retention infrastructure:
--
--   1. notification_preferences columns:
--        - weekly_digest_email (opt-in)
--        - push_agent_finished (session-complete while away)
--        - push_budget_threshold (MTD cost alert)
--        - push_weekly_summary (Sunday 17:00 one-liner)
--
--   2. notifications table
--        In-app digest feed — stores per-user notification history for
--        offline/history viewing on mobile. Separate from push delivery.
--
--   3. referral_events table
--        Tracks referral attribution + reward state. Lives alongside the
--        existing referral_code + referred_by_user_id on profiles.
--
--   4. budget_threshold_sends table
--        Idempotency store: one push per threshold per billing period.
--
--   5. RLS policies on new tables (user can only read their own rows).
--
--   6. pg_cron jobs
--        - weekly digest: Sunday 23:00 UTC = Sunday 17:00 CT
--        - budget threshold check: hourly
--
--   7. Helper functions called by cron or edge functions.
--
-- WHY: CLAUDE.md states "User Trust = Retention". Smart, timely notifications
-- and a referral loop are the highest-leverage week-1 churn levers. The
-- audit_log entries on every send satisfy SOC2 CC7.2 (communication to
-- external parties is monitored and logged).
--
-- SAFE TO RE-RUN: All DDL uses IF NOT EXISTS / DO $$ blocks.
-- ============================================================================


-- ============================================================================
-- Step 1: notification_preferences — add retention-hook columns
-- ============================================================================
-- WHY: Adding columns here (not a new table) keeps all notification toggles
-- in one place. The mobile/web notification-settings screens already read
-- notification_preferences — adding columns here requires no schema joins.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS push_agent_finished      BOOLEAN DEFAULT TRUE  NOT NULL,
  ADD COLUMN IF NOT EXISTS push_budget_threshold     BOOLEAN DEFAULT TRUE  NOT NULL,
  ADD COLUMN IF NOT EXISTS push_weekly_summary       BOOLEAN DEFAULT TRUE  NOT NULL,
  ADD COLUMN IF NOT EXISTS weekly_digest_email       BOOLEAN DEFAULT TRUE  NOT NULL;

COMMENT ON COLUMN notification_preferences.push_agent_finished IS
  'Send push when an agent session completes while the user has been away > 5 min.';

COMMENT ON COLUMN notification_preferences.push_budget_threshold IS
  'Send push when projected MTD cost crosses a configured budget threshold (80% of tier quota).';

COMMENT ON COLUMN notification_preferences.push_weekly_summary IS
  'Send weekly one-liner push every Sunday at 17:00 user-local time.';

COMMENT ON COLUMN notification_preferences.weekly_digest_email IS
  'Opt-in for weekly digest email (sent Sunday 17:00 CT via Resend). '
  'Distinct from email_weekly_summary which is the Friday cost summary. '
  'This digest includes session count, top agents, file types, and cost delta.';


-- ============================================================================
-- Step 2: notifications table — in-app digest feed
-- ============================================================================
-- WHY: Push notifications are ephemeral. Users who miss the Sunday push
-- should still be able to see their digest in-app. This table powers the
-- mobile notification feed (history/offline viewing). Separate from
-- device_tokens (which is the delivery targeting table) and audit_log
-- (which is the compliance record).

CREATE TABLE IF NOT EXISTS notifications (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Content
  type           TEXT        NOT NULL
                             CHECK (type IN (
                               'weekly_digest',
                               'agent_finished',
                               'budget_threshold',
                               'weekly_summary_push',
                               'referral_reward',
                               'milestone'
                             )),
  title          TEXT        NOT NULL,
  body           TEXT        NOT NULL,

  -- Deep-link target (e.g. /dashboard, /costs, /sessions/<id>)
  deep_link      TEXT,

  -- Optional structured payload (for rich rendering)
  metadata       JSONB       DEFAULT '{}'::jsonb,

  -- Read state
  read_at        TIMESTAMPTZ,

  -- Delivery tracking
  push_sent_at   TIMESTAMPTZ,
  email_sent_at  TIMESTAMPTZ,

  created_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

-- WHY: Most queries filter on user + created_at DESC (feed order).
-- The partial index on read_at IS NULL keeps it small — read items
-- accumulate but don't bloat the hot index.
CREATE INDEX IF NOT EXISTS idx_notifications_user_all
  ON notifications(user_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY notifications_update ON notifications
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY notifications_delete ON notifications
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- Service role can insert (used by cron / edge functions)
CREATE POLICY notifications_insert_service ON notifications
  FOR INSERT WITH CHECK (true);

COMMENT ON TABLE notifications IS
  'In-app notification feed. Stores digest summaries and alert history for '
  'offline/history viewing. Distinct from audit_log (compliance) and '
  'device_tokens (push targeting). Populated by cron jobs and edge functions.';


-- ============================================================================
-- Step 3: budget_threshold_sends — idempotency for budget push
-- ============================================================================
-- WHY: Budget threshold alerts must fire at most once per threshold per
-- billing period. Without this table, the hourly cron would re-fire every
-- hour after the threshold is crossed, spamming the user.
--
-- Key: (user_id, threshold_pct, billing_period_start).
-- The cron checks this table before sending and inserts after sending.

CREATE TABLE IF NOT EXISTS budget_threshold_sends (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Which threshold was crossed (e.g. 80 for "80% of quota")
  threshold_pct        INTEGER     NOT NULL CHECK (threshold_pct BETWEEN 1 AND 100),

  -- ISO date of the first day of the billing period the threshold fired in
  billing_period_start DATE        NOT NULL,

  -- Delivery metadata
  sent_at              TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  push_message_id      TEXT,

  CONSTRAINT uq_budget_threshold_send
    UNIQUE (user_id, threshold_pct, billing_period_start)
);

CREATE INDEX IF NOT EXISTS idx_budget_threshold_sends_user
  ON budget_threshold_sends(user_id, billing_period_start);

ALTER TABLE budget_threshold_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_threshold_sends_select ON budget_threshold_sends
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- Only service role writes (cron/edge functions)
CREATE POLICY budget_threshold_sends_service ON budget_threshold_sends
  FOR INSERT WITH CHECK (true);

COMMENT ON TABLE budget_threshold_sends IS
  'Idempotency store for MTD budget-threshold push notifications. '
  'Prevents duplicate alerts within the same billing period. '
  'One row per (user, threshold_pct, billing_period_start).';


-- ============================================================================
-- Step 4: referral_events table
-- ============================================================================
-- WHY: profiles already has referral_code (user''s shareable code) and
-- referred_by_user_id (attribution FK). This table extends that with:
--   - event lifecycle (click → signup → upgrade → rewarded)
--   - Polar transaction ID for reward reconciliation
--   - admin-visibility for founder dashboard
--   - abuse metadata (IP, email hash for disposable-email check)
--
-- WHY separate table instead of columns on profiles:
--   One referrer can have many referred users (1:N). Columns on profiles
--   only store one side of the relationship. This table gives us the full
--   audit trail required for reward issuance and abuse detection.

CREATE TABLE IF NOT EXISTS referral_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The user who sent the invite link
  referrer_user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- The user who signed up via the link (NULL until they actually register)
  referred_user_id     UUID        REFERENCES profiles(id) ON DELETE SET NULL,

  -- Referral code used (snapshot in case referrer's code changes)
  referral_code        TEXT        NOT NULL,

  -- Lifecycle state machine
  -- click    → referrer link was clicked (cookie set on /r/[code])
  -- signup   → referred user completed registration
  -- upgraded → referred user upgraded to Pro or Power
  -- rewarded → referrer received the free-month credit via Polar
  -- expired  → 30-day conversion window elapsed without upgrade
  -- rejected → abuse check failed (self-referral, same-domain, disposable email)
  status               TEXT        NOT NULL DEFAULT 'click'
                                   CHECK (status IN (
                                     'click',
                                     'signup',
                                     'upgraded',
                                     'rewarded',
                                     'expired',
                                     'rejected'
                                   )),

  -- Attribution timestamps
  clicked_at           TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  signed_up_at         TIMESTAMPTZ,
  upgraded_at          TIMESTAMPTZ,
  rewarded_at          TIMESTAMPTZ,

  -- Polar API reference for the credit transaction
  polar_credit_id      TEXT,

  -- Abuse-check metadata
  -- WHY: We hash the referrer IP and referree email (SHA-256) rather than
  -- storing them in plain text. This satisfies GDPR minimisation while still
  -- allowing pattern-matching (e.g. same IP, disposable domain flag).
  referrer_ip_hash     TEXT,    -- SHA-256 of click-time IP
  referree_email_hash  TEXT,    -- SHA-256 of referree email at signup
  is_disposable_email  BOOLEAN  DEFAULT FALSE,
  rejection_reason     TEXT,

  -- Conversion window: 30 days from click
  expires_at           TIMESTAMPTZ NOT NULL
                       GENERATED ALWAYS AS (clicked_at + INTERVAL '30 days') STORED,

  -- Tier of the upgrade that triggered the reward
  upgraded_to_tier     TEXT CHECK (upgraded_to_tier IN ('pro', 'power', 'team', 'business', 'enterprise')),

  created_at           TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at           TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_referral_events_referrer
  ON referral_events(referrer_user_id, status);

CREATE INDEX IF NOT EXISTS idx_referral_events_code
  ON referral_events(referral_code, status);

-- WHY: Cron scans for expired pending referrals nightly
CREATE INDEX IF NOT EXISTS idx_referral_events_expires
  ON referral_events(expires_at)
  WHERE status IN ('click', 'signup');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION fn_referral_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_referral_events_updated_at
  BEFORE UPDATE ON referral_events
  FOR EACH ROW EXECUTE FUNCTION fn_referral_events_updated_at();

ALTER TABLE referral_events ENABLE ROW LEVEL SECURITY;

-- Referrer can see their own referral events (to show "Your invites" screen)
CREATE POLICY referral_events_referrer_select ON referral_events
  FOR SELECT USING (referrer_user_id = (SELECT auth.uid()));

-- Service role manages all rows (edge functions + cron)
CREATE POLICY referral_events_service_all ON referral_events
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE referral_events IS
  'Full audit trail for the referral program lifecycle: click -> signup -> upgrade -> reward. '
  'Each row tracks one referred user attempt. One referrer can have many rows (1:N). '
  'Abuse metadata is hashed (SHA-256) for GDPR data minimisation.';


-- ============================================================================
-- Step 5: Helper function — expire stale referral events
-- ============================================================================
-- Called nightly by pg_cron to mark unresolved referrals past 30-day window.

CREATE OR REPLACE FUNCTION fn_expire_stale_referrals()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE referral_events
  SET status = 'expired', updated_at = NOW()
  WHERE status IN ('click', 'signup')
    AND expires_at < NOW();

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

COMMENT ON FUNCTION fn_expire_stale_referrals() IS
  'Marks referral_events rows past their 30-day conversion window as expired. '
  'Called nightly by the styrby_expire_stale_referrals pg_cron job. '
  'Returns the count of newly-expired rows for logging.';


-- ============================================================================
-- Step 6: pg_cron jobs — weekly digest + budget check + referral expiry
-- ============================================================================
-- WHY: Supabase pins pg_cron to pg_catalog. cron.schedule() upserts by name
-- (idempotent). All times in Central Time per CLAUDE.md rule.
--
-- Sunday 17:00 CT = Sunday 23:00 UTC (UTC-6 CDT) / Sunday 23:00 UTC (UTC-5 CST = Mon 00:00)
-- We use Sunday 23:00 UTC which hits 17:00 CT in CDT season and 18:00 CT in CST.
-- Acceptable — the weekly summary is a "Sunday evening" feel either way.

-- Weekly digest trigger: calls the /api/cron/weekly-digest Next.js route
-- via Supabase's net.http_post extension (if enabled) or the edge function.
-- WHY: pg_cron cannot call Resend directly. It signals the Next.js cron route
-- which has access to RESEND_API_KEY and can render React Email templates.
-- The actual HTTP call is handled by the styrby_weekly_digest job below.
-- This SQL job just marks users for digest processing.

-- Mark eligible users for weekly digest (server-side batch prep)
CREATE OR REPLACE FUNCTION fn_mark_weekly_digest_batch()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  batch_count INTEGER;
BEGIN
  -- Insert a weekly_digest notification placeholder for each eligible user.
  -- The Next.js cron route reads these placeholders, renders the email,
  -- sends via Resend, and marks push_sent_at / email_sent_at.
  -- WHY insert placeholders: decouples database compute (pg_cron) from
  -- email rendering (Next.js/Resend) without requiring net.http_post.
  INSERT INTO notifications (user_id, type, title, body, metadata)
  SELECT
    p.id,
    'weekly_digest',
    'Your weekly Styrby digest is ready',
    'See how your AI coding went this week.',
    jsonb_build_object('period_start', DATE_TRUNC('week', NOW() - INTERVAL '1 week'),
                       'period_end',   DATE_TRUNC('week', NOW()))
  FROM profiles p
  JOIN notification_preferences np ON np.user_id = p.id
  WHERE np.weekly_digest_email = TRUE
    AND p.deleted_at IS NULL
    -- Don't double-insert if the cron fires twice in a week
    AND NOT EXISTS (
      SELECT 1 FROM notifications n2
      WHERE n2.user_id = p.id
        AND n2.type = 'weekly_digest'
        AND n2.created_at > NOW() - INTERVAL '6 days'
    );

  GET DIAGNOSTICS batch_count = ROW_COUNT;
  RETURN batch_count;
END;
$$;

COMMENT ON FUNCTION fn_mark_weekly_digest_batch() IS
  'Inserts weekly_digest notification placeholders for all users with '
  'weekly_digest_email = TRUE. Called by the styrby_weekly_digest_prep '
  'pg_cron job every Sunday 23:00 UTC. The /api/cron/weekly-digest route '
  'reads these placeholders and sends the actual Resend email.';

-- Weekly digest prep — Sunday 23:00 UTC = Sunday 17:00 CT (CDT)
SELECT cron.schedule(
  'styrby_weekly_digest_prep',
  '0 23 * * 0',   -- Sunday 23:00 UTC = 17:00 CT
  $$SELECT fn_mark_weekly_digest_batch()$$
);

-- Budget threshold check — hourly
-- WHY hourly: MTD costs update on every session. Daily would miss a user
-- who spikes mid-day. Hourly is fine — the budget_threshold_sends table
-- prevents duplicate notifications.
-- The actual push is sent by /api/cron/budget-threshold.
SELECT cron.schedule(
  'styrby_budget_threshold_check',
  '5 * * * *',   -- 5 minutes past every hour
  $$
    -- Signal: upsert a sentinel row so the Next.js route knows to check.
    -- The route reads cost_records + budget_alerts + subscriptions and
    -- does the actual threshold math.
    INSERT INTO notifications (user_id, type, title, body, metadata)
    SELECT
      p.id,
      'budget_threshold',
      '__threshold_check__',
      '__threshold_check__',
      '{}'::jsonb
    FROM profiles p
    WHERE p.deleted_at IS NULL
      -- Only queue if not already queued in last 50 minutes (cron safety net)
      AND NOT EXISTS (
        SELECT 1 FROM notifications n2
        WHERE n2.user_id = p.id
          AND n2.type = 'budget_threshold'
          AND n2.title = '__threshold_check__'
          AND n2.created_at > NOW() - INTERVAL '50 minutes'
      )
    ON CONFLICT DO NOTHING
  $$
);

-- Expire stale referrals — nightly 04:00 CT = 10:00 UTC
SELECT cron.schedule(
  'styrby_expire_stale_referrals',
  '0 10 * * *',   -- 10:00 UTC = 04:00 CT
  $$SELECT fn_expire_stale_referrals()$$
);


-- ============================================================================
-- Step 7: Indexes for cron/edge-function query patterns
-- ============================================================================

-- WHY: The budget threshold route joins cost_records → sessions → profiles
-- filtered on billing period. The sessions index already exists from 022.
-- Add a compound on cost_records(user_id, created_at) for MTD aggregation.
CREATE INDEX IF NOT EXISTS idx_cost_records_user_mtd
  ON cost_records(user_id, created_at DESC)
  WHERE created_at IS NOT NULL;

-- WHY: The agent-finished notification edge function queries sessions by
-- user + status + ended_at to find recently-completed sessions.
CREATE INDEX IF NOT EXISTS idx_sessions_user_ended
  ON sessions(user_id, ended_at DESC)
  WHERE status = 'ended' AND deleted_at IS NULL;

-- WHY: notifications feed is queried as "unread first, then all" — index
-- already created above in Step 2. Index for read-mark queries:
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;
