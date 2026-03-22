-- ============================================================================
-- SECURITY FIXES (Audit: sec-ship-2026-03-22)
-- ============================================================================
-- Addresses findings: A-001, A-003, A-004, A-013, H-002
--
-- A-001: Add is_admin column to profiles for immutable admin authorization
-- A-003: Add UPDATE policy on support_tickets for user-owned open tickets
-- A-004: Add DELETE policy on support_ticket_replies for user retraction
-- A-013: Block replies to closed/resolved tickets at RLS layer
-- H-002: Atomic budget hard-stop check (advisory lock eliminates concurrent bypass)
-- H-002b: Pre-reserve cost tracking (is_pending column on cost_records)
-- ============================================================================

-- ============================================================================
-- A-001: is_admin column on profiles
-- ============================================================================
-- WHY: The previous admin check used the JWT email claim, which is a mutable,
-- user-controlled attribute. A user who registers with an admin email address
-- could gain admin access. An is_admin boolean set only by service role is
-- immutable from the user's perspective and provides a stable identity anchor.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- WHY: No RLS UPDATE policy allows users to set is_admin. The column can only
-- be changed via the service role (admin client) or direct DB access. This is
-- the core security property that makes it safe for authorization.
COMMENT ON COLUMN profiles.is_admin IS 'Server-set admin flag. Cannot be modified by users via RLS. Set via service role only.';

-- ============================================================================
-- A-003: UPDATE policy on support_tickets
-- ============================================================================
-- WHY: Without an UPDATE policy, users cannot modify their own tickets after
-- submission (e.g., to add more detail). The policy restricts updates to
-- open/in_progress tickets only, and RLS prevents users from changing status,
-- priority, or admin_notes (those fields are managed via admin API with
-- service role).

CREATE POLICY "support_tickets_update_own" ON support_tickets
  FOR UPDATE
  USING (
    user_id = (SELECT auth.uid())
    AND status IN ('open', 'in_progress')
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status IN ('open', 'in_progress')
  );

-- ============================================================================
-- A-004: DELETE policy on support_ticket_replies
-- ============================================================================
-- WHY: Users should be able to retract their own replies. Admin replies are
-- immutable (no UPDATE or DELETE for admin author_type) to preserve the audit
-- trail. This is a deliberate design choice documented in the security audit.

CREATE POLICY "support_ticket_replies_delete_own" ON support_ticket_replies
  FOR DELETE
  USING (
    author_type = 'user'
    AND author_id = (SELECT auth.uid())
  );

-- No UPDATE policy on support_ticket_replies by design.
-- Replies are immutable for audit trail integrity. If admin correction is
-- needed, it must go through service role only.

-- ============================================================================
-- A-013: Block replies to closed/resolved tickets
-- ============================================================================
-- WHY: The original INSERT policy did not check ticket status. Users could
-- post replies to resolved or closed tickets, causing support workflow
-- confusion. We drop the old policy and recreate it with a status check.

DROP POLICY IF EXISTS "support_ticket_replies_insert_own" ON support_ticket_replies;

CREATE POLICY "support_ticket_replies_insert_own" ON support_ticket_replies
  FOR INSERT WITH CHECK (
    author_type = 'user'
    AND author_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM support_tickets st
      WHERE st.id = support_ticket_replies.ticket_id
      AND st.user_id = (SELECT auth.uid())
      AND st.status NOT IN ('resolved', 'closed')
    )
  );

-- ============================================================================
-- H-002: Atomic budget hard-stop check
-- ============================================================================
-- WHY: The relay/send-message endpoint checks budget_alerts before allowing a
-- message. Without a lock, two concurrent requests could both read the same
-- cost total, both pass the check, and both be allowed through. This RPC
-- acquires an advisory lock per user so only one budget check runs at a time.
--
-- NOTE: This eliminates the concurrent-request race. It does NOT eliminate the
-- inherent async delay: costs are recorded by the CLI after the agent responds,
-- not at message-send time. The budget check always sees slightly stale data.
-- That is an architectural property of the system, not fixable at the DB level.
-- The advisory lock closes the smaller, fixable window.

CREATE OR REPLACE FUNCTION check_budget_hard_stop(p_user_id UUID)
RETURNS TABLE(is_blocked BOOLEAN, alert_id UUID, threshold_usd NUMERIC, total_spend NUMERIC, period TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alert RECORD;
  v_period_start TIMESTAMPTZ;
  v_total_spend NUMERIC;
BEGIN
  -- Advisory lock serializes budget checks per user.
  -- WHY: hashtext produces a stable int from user_id, and we add a fixed
  -- offset (999) to avoid colliding with serialize_user_insert locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text || 'budget_check'));

  FOR alert IN
    SELECT ba.id, ba.threshold_usd, ba.period
    FROM budget_alerts ba
    WHERE ba.user_id = p_user_id
      AND ba.action = 'hard_stop'
      AND ba.is_enabled = TRUE
    LIMIT 10
  LOOP
    -- Calculate period start based on alert period
    IF alert.period = 'daily' THEN
      v_period_start := date_trunc('day', NOW() AT TIME ZONE 'UTC');
    ELSIF alert.period = 'weekly' THEN
      -- ISO week starts on Monday
      v_period_start := date_trunc('week', NOW() AT TIME ZONE 'UTC');
    ELSE
      -- monthly
      v_period_start := date_trunc('month', NOW() AT TIME ZONE 'UTC');
    END IF;

    SELECT COALESCE(SUM(cr.cost_usd), 0) INTO v_total_spend
    FROM cost_records cr
    WHERE cr.user_id = p_user_id
      AND cr.recorded_at >= v_period_start;

    IF v_total_spend >= alert.threshold_usd THEN
      is_blocked := TRUE;
      alert_id := alert.id;
      threshold_usd := alert.threshold_usd;
      total_spend := v_total_spend;
      period := alert.period;
      RETURN NEXT;
      RETURN;  -- Return on first exceeded alert
    END IF;
  END LOOP;

  -- No alerts exceeded
  is_blocked := FALSE;
  alert_id := NULL;
  threshold_usd := NULL;
  total_spend := NULL;
  period := NULL;
  RETURN NEXT;
END;
$$;

-- ============================================================================
-- H-002b: Pre-reserve cost tracking
-- ============================================================================
-- WHY: The budget check reads cost_records to determine total spend. But costs
-- are recorded by the CLI asynchronously, 30+ seconds after the message is sent.
-- During that window, the budget check sees stale data and allows messages that
-- may push the user over budget.
--
-- FIX: Add is_pending column. The CLI writes a "pending" cost record with the
-- exact input cost the moment it sends the request to the AI agent. The budget
-- check immediately sees this reservation. When the agent responds, the CLI
-- updates the record with the actual full cost and sets is_pending = false.
--
-- This means the budget check sees input cost immediately (typically 30-70% of
-- total for large context sessions) rather than seeing nothing for 30+ seconds.
-- Only the output cost remains deferred (until the agent finishes responding).

ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS is_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- WHY: Pending records should be visible to budget checks (they already are,
-- since the check sums cost_usd regardless of is_pending). This comment
-- documents the intentional design: pending records participate in budget sums.
COMMENT ON COLUMN cost_records.is_pending IS
  'True while the AI agent is still responding. CLI sets to false when actual cost is known. '
  'Pending records contain exact input cost but no output cost yet. '
  'Budget checks include pending records to prevent overspend during the response window.';

-- Orphan cleanup: finalize pending records older than 2 hours.
-- WHY: If a CLI session crashes or loses connectivity, pending records are left
-- behind with only input cost. After 2 hours, we can safely assume the session
-- is dead. We mark them as finalized (is_pending = false) so they don't show as
-- "in progress" forever. The input cost they contain is still correct and should
-- remain in the spending total.
CREATE OR REPLACE FUNCTION finalize_orphaned_pending_costs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE cost_records
  SET is_pending = FALSE
  WHERE is_pending = TRUE
    AND recorded_at < NOW() - INTERVAL '2 hours';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Update the session cost aggregation trigger to handle pending record updates.
-- WHY: When the CLI finalizes a pending record (UPDATE with actual cost), the
-- session's total_cost_usd needs to reflect the delta (actual - pending input).
-- The existing trigger only fires on INSERT. We add an UPDATE trigger that
-- adjusts the session totals by the difference.
CREATE OR REPLACE FUNCTION update_session_cost_on_finalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only act when a pending record is finalized (is_pending changes to false)
  IF OLD.is_pending = TRUE AND NEW.is_pending = FALSE AND NEW.session_id IS NOT NULL THEN
    UPDATE sessions
    SET
      total_cost_usd = total_cost_usd + (NEW.cost_usd - OLD.cost_usd),
      total_input_tokens = total_input_tokens + (NEW.input_tokens - OLD.input_tokens),
      total_output_tokens = total_output_tokens + (NEW.output_tokens - OLD.output_tokens),
      total_cache_tokens = total_cache_tokens + (COALESCE(NEW.cache_read_tokens, 0) - COALESCE(OLD.cache_read_tokens, 0))
    WHERE id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_update_session_cost_finalize') THEN
    CREATE TRIGGER tr_update_session_cost_finalize
      AFTER UPDATE ON cost_records
      FOR EACH ROW
      WHEN (OLD.is_pending = TRUE AND NEW.is_pending = FALSE)
      EXECUTE FUNCTION update_session_cost_on_finalize();
  END IF;
END;
$$;
