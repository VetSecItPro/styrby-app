-- ============================================================================
-- STYRBY DATABASE SCHEMA v1.0
-- ============================================================================
-- Production-grade schema for Styrby, a mobile remote control app for AI
-- coding agents (Claude Code, Codex, Gemini CLI).
--
-- Design Principles:
-- 1. Security-first: RLS on every table, no exceptions
-- 2. Query-optimized: Partial indexes, covering indexes, BRIN for time-series
-- 3. Scale-ready: Materialized views for aggregations, efficient patterns
-- 4. Audit-ready: Timestamps and soft deletes everywhere
-- 5. E2E encryption: Sensitive data encrypted client-side
-- 6. Future-proof: Room for teams, API access, integrations
--
-- Performance Patterns Used:
-- - Partial indexes: Only index rows matching common filters (deleted_at IS NULL)
-- - Covering indexes: INCLUDE columns to avoid table lookups
-- - BRIN indexes: For time-series tables (cost_records) - 100x smaller than B-tree
-- - Materialized views: Pre-aggregated daily costs for dashboard
-- - RLS optimization: (SELECT auth.uid()) instead of auth.uid() for plan caching
-- - Efficient constraints: CHECK constraints at DB level, not app level
--
-- Tables (14 total):
-- Core: profiles, machines, machine_keys, device_tokens
-- Sessions: sessions, session_messages, session_bookmarks
-- Config: agent_configs, notification_preferences, budget_alerts
-- Billing: subscriptions, cost_records
-- Features: prompt_templates, audit_log
-- ============================================================================


-- ============================================================================
-- EXTENSIONS
-- ============================================================================
-- Note: uuid-ossp and pgcrypto are pre-installed in Supabase in the extensions schema.
-- We use gen_random_uuid() (built into PostgreSQL 15+) instead of gen_random_uuid()
-- because it's faster and doesn't require schema qualification.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- Trigram for fuzzy search


-- ============================================================================
-- ENUM TYPES
-- ============================================================================
-- WHY enums: Type safety, smaller storage than TEXT, faster comparisons

CREATE TYPE agent_type AS ENUM ('claude', 'codex', 'gemini');

CREATE TYPE session_status AS ENUM (
  'starting',    -- Session initialization
  'running',     -- Agent actively responding
  'idle',        -- Open but no activity
  'paused',      -- User paused
  'stopped',     -- Cleanly terminated
  'error',       -- Terminated due to error
  'expired'      -- Timed out (Claude 5-hour limit)
);

CREATE TYPE subscription_tier AS ENUM ('free', 'pro', 'power');

CREATE TYPE subscription_status AS ENUM (
  'active',
  'trialing',
  'past_due',
  'canceled',
  'paused'
);

CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high');

CREATE TYPE message_type AS ENUM (
  'user_prompt',
  'agent_response',
  'agent_thinking',
  'permission_request',
  'permission_response',
  'tool_use',
  'tool_result',
  'error',
  'system'
);

CREATE TYPE feedback_type AS ENUM ('bug', 'feature', 'general', 'nps');

CREATE TYPE audit_action AS ENUM (
  'login',
  'logout',
  'machine_paired',
  'machine_removed',
  'session_created',
  'session_deleted',
  'subscription_changed',
  'settings_updated',
  'api_key_created',
  'api_key_revoked',
  'password_changed',
  'export_requested'
);


-- ============================================================================
-- PROFILES TABLE
-- ============================================================================
-- Extends Supabase Auth users with Styrby-specific data.
-- Auto-created via trigger when user signs up.
-- ============================================================================

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Display
  display_name TEXT,
  avatar_url TEXT,

  -- Preferences
  timezone TEXT DEFAULT 'UTC' NOT NULL,
  theme TEXT DEFAULT 'dark' NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
  preferred_language TEXT DEFAULT 'en' NOT NULL,

  -- Referral program
  referral_code TEXT UNIQUE,  -- User's unique code to share
  referred_by_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Consent tracking (GDPR/legal)
  marketing_email_consent BOOLEAN DEFAULT FALSE NOT NULL,
  tos_accepted_at TIMESTAMPTZ,
  tos_version TEXT,
  privacy_accepted_at TIMESTAMPTZ,
  privacy_version TEXT,

  -- Onboarding
  onboarding_completed_at TIMESTAMPTZ,
  onboarding_step INTEGER DEFAULT 0 NOT NULL,

  -- Engagement tracking
  last_active_at TIMESTAMPTZ DEFAULT NOW(),

  -- Soft delete
  deleted_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Primary lookup: active profiles by ID
CREATE INDEX idx_profiles_active ON profiles(id)
  WHERE deleted_at IS NULL;

-- Referral code lookup (for applying referral)
CREATE UNIQUE INDEX idx_profiles_referral_code ON profiles(referral_code)
  WHERE referral_code IS NOT NULL;

-- Find users referred by someone (for referral rewards)
CREATE INDEX idx_profiles_referred_by ON profiles(referred_by_user_id)
  WHERE referred_by_user_id IS NOT NULL;


-- ============================================================================
-- MACHINES TABLE
-- ============================================================================
-- Registered CLI instances. Each user can have multiple machines.
-- Paired via QR code to establish trust.
-- ============================================================================

CREATE TABLE machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Identification
  name TEXT NOT NULL,                    -- User-visible name
  machine_fingerprint TEXT NOT NULL,     -- Stable client-generated ID

  -- Platform info (for device list UI)
  platform TEXT CHECK (platform IN ('darwin', 'linux', 'win32')),
  platform_version TEXT,
  architecture TEXT CHECK (architecture IN ('arm64', 'x64', 'x86')),
  hostname TEXT,                         -- Computer name

  -- CLI info
  cli_version TEXT,

  -- Connection state
  is_online BOOLEAN DEFAULT FALSE NOT NULL,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_ip_address INET,                  -- For security/debugging

  -- Status
  is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  deleted_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  CONSTRAINT unique_machine_per_user UNIQUE (user_id, machine_fingerprint)
);

-- User's machines (for device list) - covering index includes display columns
CREATE INDEX idx_machines_user_list ON machines(user_id, created_at DESC)
  INCLUDE (name, platform, is_online, last_seen_at)
  WHERE deleted_at IS NULL AND is_enabled = TRUE;

-- Online machines for a user (real-time presence)
CREATE INDEX idx_machines_online ON machines(user_id)
  WHERE is_online = TRUE AND deleted_at IS NULL AND is_enabled = TRUE;


-- ============================================================================
-- MACHINE_KEYS TABLE
-- ============================================================================
-- Public keys for E2E encryption (TweetNaCl box).
-- Mobile encrypts messages with machine's public key; only CLI can decrypt.
-- ============================================================================

CREATE TABLE machine_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,

  -- Key data
  public_key TEXT NOT NULL,              -- TweetNaCl box public key, base64
  fingerprint TEXT NOT NULL,             -- SHA-256 first 16 chars for verification

  -- Key lifecycle
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ,                -- For key rotation policies

  -- One active key per machine
  CONSTRAINT unique_key_per_machine UNIQUE (machine_id)
);

-- Direct lookup by machine (primary access pattern)
CREATE INDEX idx_machine_keys_machine ON machine_keys(machine_id);


-- ============================================================================
-- DEVICE_TOKENS TABLE
-- ============================================================================
-- Push notification tokens for mobile devices (APNs/FCM).
-- Required for sending permission requests, budget alerts to mobile.
-- ============================================================================

CREATE TABLE device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Token data
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),

  -- Device info (for notification settings UI)
  device_name TEXT,                      -- "iPhone 15 Pro"
  app_version TEXT,

  -- Status
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  last_used_at TIMESTAMPTZ,
  failed_count INTEGER DEFAULT 0,        -- Track delivery failures

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Same token shouldn't be registered twice
  CONSTRAINT unique_device_token UNIQUE (token)
);

-- Active tokens for a user (sending push notifications)
CREATE INDEX idx_device_tokens_user_active ON device_tokens(user_id)
  INCLUDE (token, platform)
  WHERE is_active = TRUE;


-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
-- A session = one interaction period with an AI agent in a project.
-- Contains messages, tracks costs, has lifecycle status.
-- ============================================================================

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,

  -- Agent configuration
  agent_type agent_type NOT NULL,
  model TEXT,                            -- 'claude-sonnet-4', 'gpt-4o', etc.

  -- Session info
  title TEXT,                            -- Auto-generated or user-set
  summary TEXT,                          -- AI-generated session summary
  project_path TEXT,

  -- Git context (populated by CLI if in git repo)
  git_branch TEXT,
  git_remote_url TEXT,

  -- Organization
  tags TEXT[] DEFAULT '{}',
  is_archived BOOLEAN DEFAULT FALSE NOT NULL,

  -- State machine
  status session_status DEFAULT 'starting' NOT NULL,
  error_code TEXT,
  error_message TEXT,

  -- Timing
  started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  ended_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Aggregated costs (updated by trigger on cost_records insert)
  total_cost_usd NUMERIC(10, 6) DEFAULT 0 NOT NULL,
  total_input_tokens INTEGER DEFAULT 0 NOT NULL,
  total_output_tokens INTEGER DEFAULT 0 NOT NULL,
  total_cache_tokens INTEGER DEFAULT 0 NOT NULL,

  -- Aggregated counts
  message_count INTEGER DEFAULT 0 NOT NULL,

  -- Context window tracking (shows how "full" the session is)
  context_window_used INTEGER DEFAULT 0,
  context_window_limit INTEGER,          -- Model's limit

  -- Soft delete
  deleted_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Session list for a user (most common query) - covering index for list view
CREATE INDEX idx_sessions_user_list ON sessions(user_id, created_at DESC)
  INCLUDE (title, status, agent_type, total_cost_usd, message_count, last_activity_at)
  WHERE deleted_at IS NULL AND is_archived = FALSE;

-- Archived sessions (separate list)
CREATE INDEX idx_sessions_user_archived ON sessions(user_id, created_at DESC)
  WHERE deleted_at IS NULL AND is_archived = TRUE;

-- Active sessions for a machine (CLI reconnection)
CREATE INDEX idx_sessions_machine_active ON sessions(machine_id, status)
  WHERE status IN ('starting', 'running', 'idle', 'paused') AND deleted_at IS NULL;

-- Full-text search on title and summary
CREATE INDEX idx_sessions_search ON sessions
  USING gin((COALESCE(title, '') || ' ' || COALESCE(summary, '')) gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Sessions by tag (for filtering)
CREATE INDEX idx_sessions_tags ON sessions USING gin(tags)
  WHERE deleted_at IS NULL;

-- Recent activity (for "continue where you left off")
CREATE INDEX idx_sessions_recent_activity ON sessions(user_id, last_activity_at DESC)
  WHERE deleted_at IS NULL AND status IN ('running', 'idle', 'paused');


-- ============================================================================
-- SESSION_MESSAGES TABLE
-- ============================================================================
-- Individual messages within a session. Content is E2E encrypted.
-- High-volume table - optimized for append and sequential read.
-- ============================================================================

CREATE TABLE session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Ordering
  sequence_number INTEGER NOT NULL,
  parent_message_id UUID REFERENCES session_messages(id) ON DELETE SET NULL,

  -- Message type and content
  message_type message_type NOT NULL,
  content_encrypted TEXT,                -- E2E encrypted with TweetNaCl
  encryption_nonce TEXT,

  -- Permission request specific
  risk_level risk_level,
  permission_granted BOOLEAN,

  -- Tool use specific
  tool_name TEXT,

  -- Performance tracking
  duration_ms INTEGER,                   -- How long agent took to respond

  -- Token counts (for cost calculation)
  input_tokens INTEGER DEFAULT 0 NOT NULL,
  output_tokens INTEGER DEFAULT 0 NOT NULL,
  cache_tokens INTEGER DEFAULT 0 NOT NULL,

  -- Extensible metadata
  metadata JSONB DEFAULT '{}',

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  CONSTRAINT unique_sequence_per_session UNIQUE (session_id, sequence_number)
);

-- Messages in order (primary read pattern)
CREATE INDEX idx_messages_session_seq ON session_messages(session_id, sequence_number);

-- Recent messages (for sync/pagination)
CREATE INDEX idx_messages_session_recent ON session_messages(session_id, created_at DESC);

-- Permission requests pending approval
CREATE INDEX idx_messages_permissions_pending ON session_messages(session_id, created_at DESC)
  WHERE message_type = 'permission_request' AND permission_granted IS NULL;


-- ============================================================================
-- AGENT_CONFIGS TABLE
-- ============================================================================
-- Per-user, per-agent configuration. Controls behavior and limits.
-- ============================================================================

CREATE TABLE agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  agent_type agent_type NOT NULL,

  -- Enable/disable
  is_enabled BOOLEAN DEFAULT TRUE NOT NULL,

  -- Model settings
  default_model TEXT,
  temperature NUMERIC(2, 1) CHECK (temperature >= 0 AND temperature <= 2),

  -- Custom prompts
  custom_system_prompt TEXT,             -- Prepended to agent's default

  -- Permission automation (power user feature)
  auto_approve_low_risk BOOLEAN DEFAULT FALSE NOT NULL,
  auto_approve_patterns TEXT[] DEFAULT '{}',  -- Tool/path patterns to auto-approve
  blocked_tools TEXT[] DEFAULT '{}',          -- Tools never allowed

  -- Cost controls
  max_tokens_per_request INTEGER CHECK (max_tokens_per_request > 0),
  max_cost_per_session_usd NUMERIC(10, 2) CHECK (max_cost_per_session_usd > 0),

  -- Bring your own key (encrypted)
  api_key_encrypted TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- One config per user per agent
  CONSTRAINT unique_agent_config UNIQUE (user_id, agent_type)
);

-- User's configs (settings page)
CREATE INDEX idx_agent_configs_user ON agent_configs(user_id);


-- ============================================================================
-- COST_RECORDS TABLE
-- ============================================================================
-- Detailed token usage and cost tracking. High-volume, time-series data.
-- Uses BRIN index for efficient date range queries.
-- ============================================================================

CREATE TABLE cost_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  message_id UUID REFERENCES session_messages(id) ON DELETE SET NULL,

  -- What was used
  agent_type agent_type NOT NULL,
  model TEXT NOT NULL,

  -- Token counts
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER DEFAULT 0 CHECK (cache_write_tokens >= 0),

  -- Cost calculation (stored for historical accuracy - prices change)
  cost_usd NUMERIC(10, 6) NOT NULL CHECK (cost_usd >= 0),
  price_per_input_token NUMERIC(12, 10),
  price_per_output_token NUMERIC(12, 10),

  -- Time partitioning
  recorded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  record_date DATE DEFAULT CURRENT_DATE NOT NULL
);

-- BRIN index for date range queries (100x smaller than B-tree for time-series)
-- Assumes records are inserted roughly in chronological order
CREATE INDEX idx_cost_records_date_brin ON cost_records
  USING BRIN(record_date) WITH (pages_per_range = 32);

-- User's costs by date (for daily/weekly/monthly aggregation)
CREATE INDEX idx_cost_records_user_date ON cost_records(user_id, record_date DESC);

-- Per-session costs
CREATE INDEX idx_cost_records_session ON cost_records(session_id)
  WHERE session_id IS NOT NULL;

-- Per-agent breakdown
CREATE INDEX idx_cost_records_user_agent ON cost_records(user_id, agent_type, record_date DESC);


-- ============================================================================
-- SUBSCRIPTIONS TABLE
-- ============================================================================
-- Synced from Polar via webhooks. Source of truth for billing.
-- ============================================================================

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Polar identifiers
  polar_subscription_id TEXT NOT NULL UNIQUE,
  polar_customer_id TEXT NOT NULL,
  polar_product_id TEXT,

  -- Subscription state
  tier subscription_tier DEFAULT 'free' NOT NULL,
  status subscription_status DEFAULT 'active' NOT NULL,

  -- Billing cycle
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  is_annual BOOLEAN DEFAULT FALSE NOT NULL,

  -- Trial
  trial_start TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,

  -- Cancellation
  cancel_at_period_end BOOLEAN DEFAULT FALSE NOT NULL,
  canceled_at TIMESTAMPTZ,

  -- Payment info (for display)
  billing_email TEXT,
  payment_method_last4 TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- One subscription per user
  CONSTRAINT unique_subscription UNIQUE (user_id)
);

-- Tier check (feature gating)
CREATE INDEX idx_subscriptions_user_tier ON subscriptions(user_id, tier, status);


-- ============================================================================
-- BUDGET_ALERTS TABLE
-- ============================================================================
-- User-configured spending thresholds that trigger notifications.
-- ============================================================================

CREATE TABLE budget_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Alert definition
  name TEXT NOT NULL,
  threshold_usd NUMERIC(10, 2) NOT NULL CHECK (threshold_usd > 0),
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),

  -- Scope (optional filters)
  agent_type agent_type,                 -- NULL = all agents

  -- Action
  action TEXT NOT NULL CHECK (action IN ('notify', 'warn_and_slowdown', 'hard_stop')),
  notification_channels TEXT[] DEFAULT '{push, in_app}' NOT NULL,

  -- Status
  is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  last_triggered_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Active alerts for budget checking (on cost record insert)
CREATE INDEX idx_budget_alerts_active ON budget_alerts(user_id, is_enabled)
  INCLUDE (threshold_usd, period, action, agent_type)
  WHERE is_enabled = TRUE;


-- ============================================================================
-- NOTIFICATION_PREFERENCES TABLE
-- ============================================================================
-- User preferences for push notifications and alerts.
-- ============================================================================

CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Push notifications
  push_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  push_permission_requests BOOLEAN DEFAULT TRUE NOT NULL,
  push_session_errors BOOLEAN DEFAULT TRUE NOT NULL,
  push_budget_alerts BOOLEAN DEFAULT TRUE NOT NULL,
  push_session_complete BOOLEAN DEFAULT FALSE NOT NULL,

  -- Email notifications
  email_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  email_weekly_summary BOOLEAN DEFAULT TRUE NOT NULL,
  email_budget_alerts BOOLEAN DEFAULT TRUE NOT NULL,

  -- Quiet hours (no push during these times)
  quiet_hours_enabled BOOLEAN DEFAULT FALSE NOT NULL,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  quiet_hours_timezone TEXT DEFAULT 'UTC',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT unique_notification_prefs UNIQUE (user_id)
);


-- ============================================================================
-- SESSION_BOOKMARKS TABLE
-- ============================================================================
-- Starred/saved sessions for quick access.
-- ============================================================================

CREATE TABLE session_bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Organization
  note TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT unique_bookmark UNIQUE (user_id, session_id)
);

-- User's bookmarks (bookmark list)
CREATE INDEX idx_bookmarks_user ON session_bookmarks(user_id, created_at DESC)
  INCLUDE (session_id, note);


-- ============================================================================
-- PROMPT_TEMPLATES TABLE
-- ============================================================================
-- Reusable prompts for common tasks. System templates + user-created.
-- ============================================================================

CREATE TABLE prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,  -- NULL = system template

  -- Template content
  name TEXT NOT NULL,
  description TEXT,
  prompt_text TEXT NOT NULL,

  -- Categorization
  category TEXT,                         -- 'debugging', 'refactoring', 'testing'
  agent_type agent_type,                 -- NULL = works with any agent
  tags TEXT[] DEFAULT '{}',

  -- Visibility
  is_system BOOLEAN DEFAULT FALSE NOT NULL,  -- System-provided template
  is_public BOOLEAN DEFAULT FALSE NOT NULL,  -- Community sharing (future)

  -- Usage tracking
  use_count INTEGER DEFAULT 0 NOT NULL,
  last_used_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- System templates (loaded for all users)
CREATE INDEX idx_templates_system ON prompt_templates(category, name)
  WHERE is_system = TRUE;

-- User's custom templates
CREATE INDEX idx_templates_user ON prompt_templates(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Popular templates (for discovery)
CREATE INDEX idx_templates_popular ON prompt_templates(use_count DESC)
  WHERE is_public = TRUE;


-- ============================================================================
-- OFFLINE_COMMAND_QUEUE TABLE
-- ============================================================================
-- Commands queued on mobile when offline. Synced when connection restored.
-- ============================================================================

CREATE TABLE offline_command_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,

  -- Command data (encrypted)
  command_encrypted TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,

  -- Queue management
  queue_order INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),

  -- Error tracking
  error_message TEXT,
  retry_count INTEGER DEFAULT 0 NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  sent_at TIMESTAMPTZ
);

-- Pending commands to process (in order)
CREATE INDEX idx_offline_queue_pending ON offline_command_queue(user_id, machine_id, queue_order)
  WHERE status = 'pending';


-- ============================================================================
-- AUDIT_LOG TABLE
-- ============================================================================
-- Security and compliance audit trail. Append-only.
-- ============================================================================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- What happened
  action audit_action NOT NULL,
  resource_type TEXT,                    -- 'session', 'machine', 'subscription'
  resource_id UUID,

  -- Context
  ip_address INET,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',

  -- Timestamp (no updated_at - audit logs are immutable)
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- User's audit history (security page)
CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- BRIN for time-range queries (compliance reports)
CREATE INDEX idx_audit_log_time_brin ON audit_log
  USING BRIN(created_at) WITH (pages_per_range = 32);

-- Action type filtering
CREATE INDEX idx_audit_log_action ON audit_log(action, created_at DESC);


-- ============================================================================
-- USER_FEEDBACK TABLE
-- ============================================================================
-- In-app feedback collection for product improvement.
-- ============================================================================

CREATE TABLE user_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,

  -- Feedback content
  feedback_type feedback_type NOT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 10),
  message TEXT,

  -- Context
  app_version TEXT,
  platform TEXT CHECK (platform IN ('ios', 'android', 'web', 'cli')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Feedback by type (for analysis)
CREATE INDEX idx_feedback_type ON user_feedback(feedback_type, created_at DESC);


-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================
-- Every table has RLS enabled. Users can only access their own data.
--
-- OPTIMIZATION: Using (SELECT auth.uid()) instead of auth.uid() directly
-- allows PostgreSQL to cache the auth check across rows in the same query,
-- significantly improving performance for large result sets.
-- ============================================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_command_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- PROFILES POLICIES
-- ============================================================================

CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT
  USING (id = (SELECT auth.uid()));

CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));


-- ============================================================================
-- MACHINES POLICIES
-- ============================================================================

CREATE POLICY "machines_select_own"
  ON machines FOR SELECT
  USING (user_id = (SELECT auth.uid()) AND deleted_at IS NULL);

CREATE POLICY "machines_insert_own"
  ON machines FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "machines_update_own"
  ON machines FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "machines_delete_own"
  ON machines FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- MACHINE_KEYS POLICIES
-- ============================================================================

CREATE POLICY "machine_keys_select_own"
  ON machine_keys FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM machines
    WHERE machines.id = machine_keys.machine_id
    AND machines.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "machine_keys_insert_own"
  ON machine_keys FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM machines
    WHERE machines.id = machine_keys.machine_id
    AND machines.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "machine_keys_update_own"
  ON machine_keys FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM machines
    WHERE machines.id = machine_keys.machine_id
    AND machines.user_id = (SELECT auth.uid())
  ));


-- ============================================================================
-- DEVICE_TOKENS POLICIES
-- ============================================================================

CREATE POLICY "device_tokens_select_own"
  ON device_tokens FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "device_tokens_insert_own"
  ON device_tokens FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "device_tokens_update_own"
  ON device_tokens FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "device_tokens_delete_own"
  ON device_tokens FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- SESSIONS POLICIES
-- ============================================================================

CREATE POLICY "sessions_select_own"
  ON sessions FOR SELECT
  USING (user_id = (SELECT auth.uid()) AND deleted_at IS NULL);

CREATE POLICY "sessions_insert_own"
  ON sessions FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "sessions_update_own"
  ON sessions FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "sessions_delete_own"
  ON sessions FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- SESSION_MESSAGES POLICIES
-- ============================================================================

CREATE POLICY "session_messages_select_own"
  ON session_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.id = session_messages.session_id
    AND sessions.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "session_messages_insert_own"
  ON session_messages FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.id = session_messages.session_id
    AND sessions.user_id = (SELECT auth.uid())
  ));


-- ============================================================================
-- AGENT_CONFIGS POLICIES
-- ============================================================================

CREATE POLICY "agent_configs_select_own"
  ON agent_configs FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "agent_configs_insert_own"
  ON agent_configs FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "agent_configs_update_own"
  ON agent_configs FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "agent_configs_delete_own"
  ON agent_configs FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- COST_RECORDS POLICIES
-- ============================================================================

CREATE POLICY "cost_records_select_own"
  ON cost_records FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- INSERT/UPDATE via service role only (CLI backend, webhooks)


-- ============================================================================
-- SUBSCRIPTIONS POLICIES
-- ============================================================================

CREATE POLICY "subscriptions_select_own"
  ON subscriptions FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- INSERT/UPDATE via service role only (Polar webhooks)


-- ============================================================================
-- BUDGET_ALERTS POLICIES
-- ============================================================================

CREATE POLICY "budget_alerts_select_own"
  ON budget_alerts FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "budget_alerts_insert_own"
  ON budget_alerts FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "budget_alerts_update_own"
  ON budget_alerts FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "budget_alerts_delete_own"
  ON budget_alerts FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- NOTIFICATION_PREFERENCES POLICIES
-- ============================================================================

CREATE POLICY "notification_prefs_select_own"
  ON notification_preferences FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "notification_prefs_insert_own"
  ON notification_preferences FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "notification_prefs_update_own"
  ON notification_preferences FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));


-- ============================================================================
-- SESSION_BOOKMARKS POLICIES
-- ============================================================================

CREATE POLICY "bookmarks_select_own"
  ON session_bookmarks FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "bookmarks_insert_own"
  ON session_bookmarks FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "bookmarks_delete_own"
  ON session_bookmarks FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- PROMPT_TEMPLATES POLICIES
-- ============================================================================

-- Users can see system templates and their own
CREATE POLICY "templates_select"
  ON prompt_templates FOR SELECT
  USING (
    is_system = TRUE
    OR user_id = (SELECT auth.uid())
    OR is_public = TRUE
  );

CREATE POLICY "templates_insert_own"
  ON prompt_templates FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_system = FALSE);

CREATE POLICY "templates_update_own"
  ON prompt_templates FOR UPDATE
  USING (user_id = (SELECT auth.uid()) AND is_system = FALSE)
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_system = FALSE);

CREATE POLICY "templates_delete_own"
  ON prompt_templates FOR DELETE
  USING (user_id = (SELECT auth.uid()) AND is_system = FALSE);


-- ============================================================================
-- OFFLINE_COMMAND_QUEUE POLICIES
-- ============================================================================

CREATE POLICY "offline_queue_select_own"
  ON offline_command_queue FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "offline_queue_insert_own"
  ON offline_command_queue FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "offline_queue_update_own"
  ON offline_command_queue FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "offline_queue_delete_own"
  ON offline_command_queue FOR DELETE
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- AUDIT_LOG POLICIES
-- ============================================================================

-- Users can view their own audit log
CREATE POLICY "audit_log_select_own"
  ON audit_log FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- INSERT via service role only (server-side)


-- ============================================================================
-- USER_FEEDBACK POLICIES
-- ============================================================================

CREATE POLICY "feedback_insert"
  ON user_feedback FOR INSERT
  WITH CHECK (user_id IS NULL OR user_id = (SELECT auth.uid()));

-- SELECT via service role only (admin dashboard)


-- ============================================================================
-- TRIGGERS: AUTO-UPDATE TIMESTAMPS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_machines_updated_at BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_agent_configs_updated_at BEFORE UPDATE ON agent_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_budget_alerts_updated_at BEFORE UPDATE ON budget_alerts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_notification_prefs_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_templates_updated_at BEFORE UPDATE ON prompt_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================================
-- TRIGGERS: AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    display_name,
    avatar_url,
    referral_code
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    -- Generate unique referral code: first 8 chars of UUID
    UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8))
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================================
-- TRIGGERS: SESSION MESSAGE COUNT
-- ============================================================================

CREATE OR REPLACE FUNCTION update_session_message_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE sessions
    SET
      message_count = message_count + 1,
      last_activity_at = NOW()
    WHERE id = NEW.session_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE sessions
    SET message_count = GREATEST(message_count - 1, 0)
    WHERE id = OLD.session_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER tr_session_message_count
  AFTER INSERT OR DELETE ON session_messages
  FOR EACH ROW EXECUTE FUNCTION update_session_message_count();


-- ============================================================================
-- TRIGGERS: SESSION COST AGGREGATION
-- ============================================================================

CREATE OR REPLACE FUNCTION update_session_costs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    UPDATE sessions
    SET
      total_cost_usd = total_cost_usd + NEW.cost_usd,
      total_input_tokens = total_input_tokens + NEW.input_tokens,
      total_output_tokens = total_output_tokens + NEW.output_tokens,
      total_cache_tokens = total_cache_tokens + COALESCE(NEW.cache_read_tokens, 0)
    WHERE id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_session_costs
  AFTER INSERT ON cost_records
  FOR EACH ROW EXECUTE FUNCTION update_session_costs();


-- ============================================================================
-- FUNCTIONS: COST AGGREGATION
-- ============================================================================

-- Get user's spending for a period (for budget alert checks)
CREATE OR REPLACE FUNCTION get_user_spending(
  p_user_id UUID,
  p_period TEXT,
  p_agent_type agent_type DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_date DATE;
  v_total NUMERIC;
BEGIN
  v_start_date := CASE p_period
    WHEN 'daily' THEN CURRENT_DATE
    WHEN 'weekly' THEN CURRENT_DATE - INTERVAL '7 days'
    WHEN 'monthly' THEN CURRENT_DATE - INTERVAL '30 days'
    ELSE CURRENT_DATE
  END;

  SELECT COALESCE(SUM(cost_usd), 0)
  INTO v_total
  FROM cost_records
  WHERE user_id = p_user_id
    AND record_date >= v_start_date
    AND (p_agent_type IS NULL OR agent_type = p_agent_type);

  RETURN v_total;
END;
$$;


-- Get spending breakdown by agent (for dashboard pie chart)
CREATE OR REPLACE FUNCTION get_spending_by_agent(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  agent agent_type,
  total_cost NUMERIC,
  total_tokens BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    agent_type,
    SUM(cost_usd)::NUMERIC,
    SUM(input_tokens + output_tokens)::BIGINT
  FROM cost_records
  WHERE user_id = p_user_id
    AND record_date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
  GROUP BY agent_type
  ORDER BY SUM(cost_usd) DESC;
END;
$$;


-- Get daily spending (for line chart)
CREATE OR REPLACE FUNCTION get_daily_spending(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  date DATE,
  total_cost NUMERIC,
  claude_cost NUMERIC,
  codex_cost NUMERIC,
  gemini_cost NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    record_date,
    SUM(cost_usd)::NUMERIC,
    SUM(CASE WHEN agent_type = 'claude' THEN cost_usd ELSE 0 END)::NUMERIC,
    SUM(CASE WHEN agent_type = 'codex' THEN cost_usd ELSE 0 END)::NUMERIC,
    SUM(CASE WHEN agent_type = 'gemini' THEN cost_usd ELSE 0 END)::NUMERIC
  FROM cost_records
  WHERE user_id = p_user_id
    AND record_date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
  GROUP BY record_date
  ORDER BY record_date;
END;
$$;


-- ============================================================================
-- MATERIALIZED VIEW: DAILY COST SUMMARY
-- ============================================================================
-- Pre-aggregated daily costs for fast dashboard loading.
-- Refresh nightly via cron job.
-- ============================================================================

CREATE MATERIALIZED VIEW mv_daily_cost_summary AS
SELECT
  user_id,
  record_date,
  agent_type,
  SUM(cost_usd) AS total_cost,
  SUM(input_tokens) AS total_input_tokens,
  SUM(output_tokens) AS total_output_tokens,
  SUM(cache_read_tokens) AS total_cache_tokens,
  COUNT(*) AS record_count
FROM cost_records
GROUP BY user_id, record_date, agent_type;

-- Index for fast lookups
CREATE UNIQUE INDEX idx_mv_daily_cost ON mv_daily_cost_summary(user_id, record_date, agent_type);

-- Function to refresh (called by cron)
CREATE OR REPLACE FUNCTION refresh_daily_cost_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_cost_summary;
END;
$$;


-- ============================================================================
-- SEED DATA: SYSTEM PROMPT TEMPLATES
-- ============================================================================

INSERT INTO prompt_templates (id, name, description, prompt_text, category, is_system) VALUES
  (gen_random_uuid(), 'Debug This Error', 'Help debug an error message', 'I''m seeing this error: [paste error]. Please help me understand what''s causing it and how to fix it.', 'debugging', TRUE),
  (gen_random_uuid(), 'Explain This Code', 'Get a clear explanation of code', 'Please explain what this code does, step by step: [paste code]', 'learning', TRUE),
  (gen_random_uuid(), 'Write Tests', 'Generate unit tests for code', 'Please write comprehensive unit tests for this code, including edge cases: [paste code]', 'testing', TRUE),
  (gen_random_uuid(), 'Refactor for Readability', 'Clean up messy code', 'Please refactor this code to improve readability and maintainability while preserving functionality: [paste code]', 'refactoring', TRUE),
  (gen_random_uuid(), 'Add TypeScript Types', 'Add type annotations', 'Please add TypeScript types to this code, being as specific as possible: [paste code]', 'typescript', TRUE),
  (gen_random_uuid(), 'Security Review', 'Check for vulnerabilities', 'Please review this code for security vulnerabilities (XSS, injection, auth issues, etc.): [paste code]', 'security', TRUE),
  (gen_random_uuid(), 'Performance Optimization', 'Make code faster', 'Please analyze this code for performance issues and suggest optimizations: [paste code]', 'performance', TRUE),
  (gen_random_uuid(), 'Add Error Handling', 'Improve error handling', 'Please add comprehensive error handling to this code, including appropriate error messages: [paste code]', 'robustness', TRUE),
  (gen_random_uuid(), 'Convert to Async/Await', 'Modernize Promise code', 'Please convert this Promise-based code to use async/await: [paste code]', 'refactoring', TRUE),
  (gen_random_uuid(), 'Add Documentation', 'Write JSDoc comments', 'Please add comprehensive JSDoc documentation to this code: [paste code]', 'documentation', TRUE),
  (gen_random_uuid(), 'Create API Endpoint', 'Scaffold a new API route', 'Please create a [METHOD] API endpoint for [describe functionality] with proper validation, error handling, and types.', 'api', TRUE),
  (gen_random_uuid(), 'Database Query', 'Write optimized SQL', 'Please write an optimized SQL query to [describe what you need] from these tables: [describe schema]', 'database', TRUE),
  (gen_random_uuid(), 'React Component', 'Create a React component', 'Please create a React component for [describe component] with TypeScript, proper props interface, and hooks.', 'frontend', TRUE),
  (gen_random_uuid(), 'Git Commit Message', 'Write a good commit message', 'Please write a clear, conventional commit message for these changes: [describe changes]', 'git', TRUE),
  (gen_random_uuid(), 'Code Review', 'Review a PR/diff', 'Please review this code change and provide feedback on: correctness, edge cases, style, and potential issues: [paste diff]', 'review', TRUE),
  (gen_random_uuid(), 'Regex Pattern', 'Create a regex', 'Please create a regex pattern to [describe what to match] and explain how it works.', 'utilities', TRUE),
  (gen_random_uuid(), 'Environment Setup', 'Configure dev environment', 'Please help me set up [tool/framework] for this project. Current setup: [describe]', 'devops', TRUE),
  (gen_random_uuid(), 'CI/CD Pipeline', 'Create GitHub Actions', 'Please create a GitHub Actions workflow for [describe: testing, deployment, etc.]', 'devops', TRUE),
  (gen_random_uuid(), 'Docker Configuration', 'Write Dockerfile', 'Please create a Dockerfile for this [language/framework] application optimized for [production/development].', 'devops', TRUE),
  (gen_random_uuid(), 'Data Transformation', 'Transform data structures', 'Please write a function to transform this data structure: [input format] into this format: [output format]', 'utilities', TRUE);


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================
-- Service role needs full access for server-side operations

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;


-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
