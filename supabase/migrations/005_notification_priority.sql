-- ============================================================================
-- STYRBY DATABASE MIGRATION: Smart Notification Priority
-- ============================================================================
-- Adds priority scoring to notification_preferences for reducing notification
-- fatigue. Smart notifications use a priority score (1-5) to filter out
-- low-importance notifications based on user preferences.
--
-- Priority Scale:
-- 1 = Urgent only (permission requests, budget exceeded, critical errors)
-- 2 = High priority (high-risk operations, budget warnings)
-- 3 = Medium priority (medium-risk operations, session errors) [DEFAULT]
-- 4 = Most notifications (low-risk operations, session completions)
-- 5 = All notifications (informational, session started)
--
-- Tier Gating:
-- - Free users: No filtering (receive all notifications)
-- - Pro/Power users: Smart filtering enabled based on priority_threshold
--
-- Design:
-- - priority_threshold: User-set maximum priority to receive (1-5, lower = more restrictive)
-- - priority_rules: Custom JSON rules for advanced filtering (future use)
-- ============================================================================


-- ============================================================================
-- ADD COLUMNS TO NOTIFICATION_PREFERENCES
-- ============================================================================

-- Priority threshold: notifications with score > threshold are suppressed
-- Scale: 1 (urgent only) to 5 (all notifications)
-- Default: 3 (medium priority - reasonable balance)
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS priority_threshold INTEGER DEFAULT 3 NOT NULL
CONSTRAINT notification_prefs_priority_threshold_range
CHECK (priority_threshold >= 1 AND priority_threshold <= 5);

-- Custom priority rules for advanced filtering (reserved for future use)
-- Example schema: [{"event": "session_completed", "minCostUsd": 5.00, "priority": 2}]
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS priority_rules JSONB DEFAULT '[]'::JSONB NOT NULL;

-- Add constraint to ensure priority_rules is always an array
ALTER TABLE notification_preferences
ADD CONSTRAINT notification_prefs_priority_rules_is_array
CHECK (jsonb_typeof(priority_rules) = 'array');


-- ============================================================================
-- ADD COLUMN COMMENTS
-- ============================================================================

COMMENT ON COLUMN notification_preferences.priority_threshold IS
  'Notification filter threshold (1-5). Only notifications with priority <= this value are sent. '
  '1=urgent only, 2=high priority, 3=medium (default), 4=most, 5=all. Pro+ feature only.';

COMMENT ON COLUMN notification_preferences.priority_rules IS
  'Custom priority rules as JSON array for advanced filtering. Reserved for future use.';


-- ============================================================================
-- CREATE NOTIFICATION_LOGS TABLE
-- ============================================================================
-- Logs all notification events (sent and suppressed) for analytics and debugging.
-- This table tracks which notifications were filtered by priority scoring.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Notification details
  event_type TEXT NOT NULL,
  notification_title TEXT NOT NULL,
  notification_body TEXT,

  -- Priority scoring
  calculated_priority INTEGER NOT NULL CHECK (calculated_priority >= 1 AND calculated_priority <= 5),
  user_threshold INTEGER NOT NULL CHECK (user_threshold >= 1 AND user_threshold <= 5),

  -- Outcome
  was_sent BOOLEAN NOT NULL,
  suppression_reason TEXT,  -- NULL if sent, e.g., 'priority_threshold', 'quiet_hours', 'disabled'

  -- Context
  session_id UUID,
  cost_usd NUMERIC(10, 6),
  metadata JSONB DEFAULT '{}',

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- BRIN index for time-range queries (analytics reports)
CREATE INDEX IF NOT EXISTS idx_notification_logs_time_brin ON notification_logs
  USING BRIN(created_at) WITH (pages_per_range = 32);

-- User's notification history
CREATE INDEX IF NOT EXISTS idx_notification_logs_user ON notification_logs(user_id, created_at DESC);

-- Analytics: suppressed vs sent by user
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_outcome ON notification_logs(user_id, was_sent, created_at DESC);


-- ============================================================================
-- ROW LEVEL SECURITY FOR NOTIFICATION_LOGS
-- ============================================================================

ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own notification logs
CREATE POLICY "notification_logs_select_own"
  ON notification_logs FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- INSERT via service role only (server-side notification sender)


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================

GRANT ALL ON notification_logs TO service_role;


-- ============================================================================
-- FUNCTION: Get notification suppression rate
-- ============================================================================
-- Returns the percentage of notifications suppressed for a user in the past N days.
-- Used to show users how their priority threshold affects notification volume.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_notification_suppression_rate(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  total_count BIGINT,
  sent_count BIGINT,
  suppressed_count BIGINT,
  suppression_rate NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_date TIMESTAMPTZ;
BEGIN
  v_start_date := NOW() - (p_days || ' days')::INTERVAL;

  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_count,
    COUNT(*) FILTER (WHERE was_sent = TRUE)::BIGINT AS sent_count,
    COUNT(*) FILTER (WHERE was_sent = FALSE)::BIGINT AS suppressed_count,
    CASE
      WHEN COUNT(*) = 0 THEN 0::NUMERIC
      ELSE ROUND(COUNT(*) FILTER (WHERE was_sent = FALSE)::NUMERIC / COUNT(*)::NUMERIC * 100, 1)
    END AS suppression_rate
  FROM notification_logs
  WHERE user_id = p_user_id
    AND created_at >= v_start_date;
END;
$$;


-- ============================================================================
-- FUNCTION: Estimate notification rate for a threshold
-- ============================================================================
-- Given a priority threshold, estimates what percentage of the user's
-- historical notifications would have been received. Used for the UI slider
-- preview ("With this setting, you'll receive ~X% of notifications").
-- ============================================================================

CREATE OR REPLACE FUNCTION estimate_notification_rate_for_threshold(
  p_user_id UUID,
  p_threshold INTEGER,
  p_days INTEGER DEFAULT 30
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_date TIMESTAMPTZ;
  v_total BIGINT;
  v_would_receive BIGINT;
BEGIN
  v_start_date := NOW() - (p_days || ' days')::INTERVAL;

  -- Count total logged notifications
  SELECT COUNT(*) INTO v_total
  FROM notification_logs
  WHERE user_id = p_user_id
    AND created_at >= v_start_date;

  IF v_total = 0 THEN
    -- No history, return default estimates based on threshold
    -- These are rough estimates based on typical notification distribution
    RETURN CASE p_threshold
      WHEN 1 THEN 5.0   -- ~5% are urgent
      WHEN 2 THEN 15.0  -- ~15% are high priority
      WHEN 3 THEN 50.0  -- ~50% are medium priority
      WHEN 4 THEN 85.0  -- ~85% are normal priority
      WHEN 5 THEN 100.0 -- 100% if no filtering
      ELSE 50.0
    END;
  END IF;

  -- Count how many notifications would have been received at this threshold
  SELECT COUNT(*) INTO v_would_receive
  FROM notification_logs
  WHERE user_id = p_user_id
    AND created_at >= v_start_date
    AND calculated_priority <= p_threshold;

  RETURN ROUND(v_would_receive::NUMERIC / v_total::NUMERIC * 100, 1);
END;
$$;


-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
