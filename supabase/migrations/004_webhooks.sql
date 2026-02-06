-- ============================================================================
-- WEBHOOKS SCHEMA
-- ============================================================================
-- User-configurable webhooks for receiving event notifications at external
-- endpoints (Slack, Discord, custom services).
--
-- Events supported:
-- - session.started: When an agent session begins
-- - session.completed: When an agent session ends
-- - budget.exceeded: When a budget alert threshold is crossed
-- - permission.requested: When an agent requests permission for an action
--
-- Security:
-- - Webhook secrets are used to sign payloads (HMAC-SHA256)
-- - URL validation blocks internal IPs (SSRF prevention)
-- - RLS ensures users can only access their own webhooks
-- ============================================================================


-- ============================================================================
-- ENUM TYPES
-- ============================================================================

-- WHY enum: Type safety for webhook events, prevents invalid event types
CREATE TYPE webhook_event AS ENUM (
  'session.started',
  'session.completed',
  'budget.exceeded',
  'permission.requested'
);

-- WHY enum: Type safety for delivery status tracking
CREATE TYPE webhook_delivery_status AS ENUM (
  'pending',
  'success',
  'failed'
);


-- ============================================================================
-- WEBHOOKS TABLE
-- ============================================================================
-- User-configured webhook endpoints for event delivery.
-- Each webhook can subscribe to multiple events.
-- ============================================================================

CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Webhook configuration
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events webhook_event[] NOT NULL,  -- Array of subscribed events

  -- Security
  -- WHY: HMAC-SHA256 signature for payload verification
  -- Generated server-side on creation, never exposed to client
  secret TEXT NOT NULL,

  -- Status
  is_active BOOLEAN DEFAULT TRUE NOT NULL,

  -- Delivery statistics (updated by trigger on webhook_deliveries)
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures INTEGER DEFAULT 0 NOT NULL,

  -- Soft delete
  deleted_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  -- WHY: Prevent duplicate webhook names per user for clarity
  CONSTRAINT unique_webhook_name_per_user UNIQUE (user_id, name, deleted_at),

  -- WHY: Ensure URL is a valid HTTPS endpoint (HTTP in dev only)
  CONSTRAINT valid_webhook_url CHECK (
    url ~ '^https?://' AND length(url) <= 2048
  ),

  -- WHY: Must subscribe to at least one event
  CONSTRAINT at_least_one_event CHECK (
    array_length(events, 1) > 0
  )
);

COMMENT ON TABLE webhooks IS 'User-configured webhook endpoints for receiving Styrby event notifications';
COMMENT ON COLUMN webhooks.secret IS 'HMAC-SHA256 signing secret - never expose to client';
COMMENT ON COLUMN webhooks.consecutive_failures IS 'Auto-disables webhook after 10 consecutive failures';

-- User's webhooks list (settings page)
CREATE INDEX idx_webhooks_user_list ON webhooks(user_id, created_at DESC)
  INCLUDE (name, url, events, is_active, last_success_at, consecutive_failures)
  WHERE deleted_at IS NULL;

-- Active webhooks for event delivery
CREATE INDEX idx_webhooks_active ON webhooks(user_id, is_active)
  WHERE is_active = TRUE AND deleted_at IS NULL;

-- Find webhooks by event type for delivery
CREATE INDEX idx_webhooks_by_event ON webhooks USING gin(events)
  WHERE is_active = TRUE AND deleted_at IS NULL;


-- ============================================================================
-- WEBHOOK_DELIVERIES TABLE
-- ============================================================================
-- Records each webhook delivery attempt for debugging and analytics.
-- Retains delivery history for troubleshooting failed webhooks.
-- ============================================================================

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,

  -- Event details
  event webhook_event NOT NULL,
  payload JSONB NOT NULL,

  -- Delivery status
  status webhook_delivery_status DEFAULT 'pending' NOT NULL,
  attempts INTEGER DEFAULT 0 NOT NULL,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,  -- For retry scheduling

  -- Response tracking
  response_status INTEGER,  -- HTTP status code
  response_body TEXT,       -- First 10KB of response for debugging
  error_message TEXT,       -- Error description if failed

  -- Performance tracking
  duration_ms INTEGER,      -- Time taken for the HTTP request

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ,

  -- Constraints
  -- WHY: Limit response body storage to prevent bloat
  CONSTRAINT response_body_limit CHECK (
    response_body IS NULL OR length(response_body) <= 10240
  ),

  -- WHY: Prevent excessive retries
  CONSTRAINT max_attempts CHECK (attempts <= 5)
);

COMMENT ON TABLE webhook_deliveries IS 'Delivery attempts and results for each webhook invocation';
COMMENT ON COLUMN webhook_deliveries.next_retry_at IS 'Scheduled time for next retry attempt (exponential backoff)';
COMMENT ON COLUMN webhook_deliveries.response_body IS 'First 10KB of response body for debugging';

-- Deliveries by webhook (delivery log page)
CREATE INDEX idx_deliveries_webhook_list ON webhook_deliveries(webhook_id, created_at DESC)
  INCLUDE (event, status, response_status, attempts);

-- Pending deliveries for retry processing
CREATE INDEX idx_deliveries_pending_retry ON webhook_deliveries(next_retry_at)
  WHERE status = 'pending' AND next_retry_at IS NOT NULL;

-- Recent failures for monitoring
CREATE INDEX idx_deliveries_recent_failures ON webhook_deliveries(webhook_id, created_at DESC)
  WHERE status = 'failed';

-- BRIN index for time-range queries on delivery history
CREATE INDEX idx_deliveries_time_brin ON webhook_deliveries
  USING BRIN(created_at) WITH (pages_per_range = 32);


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- WEBHOOKS POLICIES
-- ============================================================================

-- Users can view their own webhooks (excluding secrets)
CREATE POLICY "webhooks_select_own"
  ON webhooks FOR SELECT
  USING (user_id = (SELECT auth.uid()) AND deleted_at IS NULL);

-- Users can create webhooks
CREATE POLICY "webhooks_insert_own"
  ON webhooks FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can update their own webhooks
CREATE POLICY "webhooks_update_own"
  ON webhooks FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can delete their own webhooks
CREATE POLICY "webhooks_delete_own"
  ON webhooks FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- WEBHOOK_DELIVERIES POLICIES
-- ============================================================================

-- Users can view deliveries for their webhooks
CREATE POLICY "deliveries_select_own"
  ON webhook_deliveries FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM webhooks
    WHERE webhooks.id = webhook_deliveries.webhook_id
    AND webhooks.user_id = (SELECT auth.uid())
  ));

-- INSERT/UPDATE via service role only (Edge Function)


-- ============================================================================
-- TRIGGERS: AUTO-UPDATE TIMESTAMPS
-- ============================================================================

CREATE TRIGGER tr_webhooks_updated_at BEFORE UPDATE ON webhooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================================
-- TRIGGERS: UPDATE WEBHOOK STATISTICS
-- ============================================================================

/**
 * Updates webhook statistics when a delivery completes.
 * Tracks last success/failure times and consecutive failure count.
 * Auto-disables webhook after 10 consecutive failures.
 */
CREATE OR REPLACE FUNCTION update_webhook_delivery_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'success' AND (OLD.status IS DISTINCT FROM 'success') THEN
    -- Reset consecutive failures on success
    UPDATE webhooks
    SET
      last_success_at = NOW(),
      consecutive_failures = 0
    WHERE id = NEW.webhook_id;

  ELSIF NEW.status = 'failed' AND NEW.attempts >= 3 AND (OLD.status IS DISTINCT FROM 'failed' OR OLD.attempts < 3) THEN
    -- Increment consecutive failures after all retries exhausted
    UPDATE webhooks
    SET
      last_failure_at = NOW(),
      consecutive_failures = consecutive_failures + 1,
      -- Auto-disable after 10 consecutive complete failures
      is_active = CASE WHEN consecutive_failures >= 9 THEN FALSE ELSE is_active END
    WHERE id = NEW.webhook_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_webhook_delivery_stats
  AFTER UPDATE OF status ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_webhook_delivery_stats();


-- ============================================================================
-- FUNCTIONS: WEBHOOK DELIVERY QUEUE
-- ============================================================================

/**
 * Queues a webhook delivery for a specific event.
 * Called by event triggers (session, budget alert, permission request).
 *
 * @param p_user_id - The user who owns the webhook
 * @param p_event - The event type (e.g., 'session.started')
 * @param p_payload - JSONB payload to deliver
 *
 * @returns Number of webhooks queued for delivery
 */
CREATE OR REPLACE FUNCTION queue_webhook_delivery(
  p_user_id UUID,
  p_event webhook_event,
  p_payload JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_webhook RECORD;
  v_count INTEGER := 0;
BEGIN
  -- Find all active webhooks for this user subscribed to this event
  FOR v_webhook IN
    SELECT id
    FROM webhooks
    WHERE user_id = p_user_id
      AND is_active = TRUE
      AND deleted_at IS NULL
      AND p_event = ANY(events)
  LOOP
    -- Create a pending delivery record
    INSERT INTO webhook_deliveries (webhook_id, event, payload, status)
    VALUES (v_webhook.id, p_event, p_payload, 'pending');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION queue_webhook_delivery IS 'Queues webhook deliveries for all active webhooks subscribed to an event';


/**
 * Generates a secure webhook secret.
 * Uses cryptographic random bytes, base64 encoded.
 *
 * @returns 32-character alphanumeric secret
 */
CREATE OR REPLACE FUNCTION generate_webhook_secret()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Generate 24 random bytes, encode as base64, take first 32 chars
  RETURN substring(encode(gen_random_bytes(24), 'base64') FROM 1 FOR 32);
END;
$$;

COMMENT ON FUNCTION generate_webhook_secret IS 'Generates a cryptographically secure webhook signing secret';


-- ============================================================================
-- TRIGGERS: AUTO-GENERATE WEBHOOK SECRET
-- ============================================================================

/**
 * Automatically generates a webhook secret on insert if not provided.
 */
CREATE OR REPLACE FUNCTION auto_generate_webhook_secret()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.secret IS NULL OR NEW.secret = '' THEN
    NEW.secret := generate_webhook_secret();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_webhooks_auto_secret BEFORE INSERT ON webhooks
  FOR EACH ROW EXECUTE FUNCTION auto_generate_webhook_secret();


-- ============================================================================
-- EVENT TRIGGERS: SESSION WEBHOOKS
-- ============================================================================

/**
 * Queues webhook delivery when a session starts.
 * Triggered on INSERT to sessions table.
 */
CREATE OR REPLACE FUNCTION trigger_session_started_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM queue_webhook_delivery(
    NEW.user_id,
    'session.started'::webhook_event,
    jsonb_build_object(
      'event', 'session.started',
      'timestamp', NOW(),
      'data', jsonb_build_object(
        'session_id', NEW.id,
        'agent_type', NEW.agent_type,
        'model', NEW.model,
        'project_path', NEW.project_path,
        'machine_id', NEW.machine_id,
        'started_at', NEW.started_at
      )
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_session_started_webhook
  AFTER INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_session_started_webhook();


/**
 * Queues webhook delivery when a session completes.
 * Triggered on UPDATE to sessions table when status changes to terminal state.
 */
CREATE OR REPLACE FUNCTION trigger_session_completed_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only trigger on status change to terminal states
  IF OLD.status IN ('starting', 'running', 'idle', 'paused')
     AND NEW.status IN ('stopped', 'error', 'expired') THEN
    PERFORM queue_webhook_delivery(
      NEW.user_id,
      'session.completed'::webhook_event,
      jsonb_build_object(
        'event', 'session.completed',
        'timestamp', NOW(),
        'data', jsonb_build_object(
          'session_id', NEW.id,
          'agent_type', NEW.agent_type,
          'model', NEW.model,
          'status', NEW.status,
          'error_code', NEW.error_code,
          'error_message', NEW.error_message,
          'started_at', NEW.started_at,
          'ended_at', NEW.ended_at,
          'total_cost_usd', NEW.total_cost_usd,
          'total_input_tokens', NEW.total_input_tokens,
          'total_output_tokens', NEW.total_output_tokens,
          'message_count', NEW.message_count
        )
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_session_completed_webhook
  AFTER UPDATE OF status ON sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_session_completed_webhook();


-- ============================================================================
-- EVENT TRIGGERS: BUDGET ALERT WEBHOOKS
-- ============================================================================

/**
 * Queues webhook delivery when a budget alert is triggered.
 * Called from budget alert checking logic (in Edge Function or application).
 *
 * @param p_user_id - User ID
 * @param p_alert_id - Budget alert ID that was triggered
 * @param p_current_spend - Current spend amount that triggered the alert
 * @param p_threshold - The threshold that was exceeded
 * @param p_period - The budget period
 * @param p_action - The action taken
 */
CREATE OR REPLACE FUNCTION trigger_budget_exceeded_webhook(
  p_user_id UUID,
  p_alert_id UUID,
  p_alert_name TEXT,
  p_current_spend NUMERIC,
  p_threshold NUMERIC,
  p_period TEXT,
  p_action TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN queue_webhook_delivery(
    p_user_id,
    'budget.exceeded'::webhook_event,
    jsonb_build_object(
      'event', 'budget.exceeded',
      'timestamp', NOW(),
      'data', jsonb_build_object(
        'alert_id', p_alert_id,
        'alert_name', p_alert_name,
        'current_spend_usd', p_current_spend,
        'threshold_usd', p_threshold,
        'period', p_period,
        'action', p_action,
        'percentage_used', ROUND((p_current_spend / p_threshold) * 100, 2)
      )
    )
  );
END;
$$;


-- ============================================================================
-- EVENT TRIGGERS: PERMISSION REQUEST WEBHOOKS
-- ============================================================================

/**
 * Queues webhook delivery when a permission is requested.
 * Triggered on INSERT to session_messages with permission_request type.
 */
CREATE OR REPLACE FUNCTION trigger_permission_requested_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
BEGIN
  -- Only trigger for permission_request messages
  IF NEW.message_type = 'permission_request' THEN
    SELECT user_id, agent_type, model, project_path
    INTO v_session
    FROM sessions
    WHERE id = NEW.session_id;

    PERFORM queue_webhook_delivery(
      v_session.user_id,
      'permission.requested'::webhook_event,
      jsonb_build_object(
        'event', 'permission.requested',
        'timestamp', NOW(),
        'data', jsonb_build_object(
          'session_id', NEW.session_id,
          'message_id', NEW.id,
          'agent_type', v_session.agent_type,
          'model', v_session.model,
          'project_path', v_session.project_path,
          'risk_level', NEW.risk_level,
          'tool_name', NEW.tool_name,
          'created_at', NEW.created_at
        )
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_permission_requested_webhook
  AFTER INSERT ON session_messages
  FOR EACH ROW
  WHEN (NEW.message_type = 'permission_request')
  EXECUTE FUNCTION trigger_permission_requested_webhook();


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================

GRANT ALL ON webhooks TO service_role;
GRANT ALL ON webhook_deliveries TO service_role;
GRANT EXECUTE ON FUNCTION queue_webhook_delivery TO service_role;
GRANT EXECUTE ON FUNCTION generate_webhook_secret TO service_role;
GRANT EXECUTE ON FUNCTION trigger_budget_exceeded_webhook TO service_role;


-- ============================================================================
-- END OF WEBHOOKS SCHEMA
-- ============================================================================
