-- Migration 081: Self-hosted uptime monitor
--
-- WHY: Replaces a paid uptime SaaS (BetterStack/Checkly) with a Vercel cron
-- + Resend stack we already pay for. The cron at /api/cron/uptime-monitor
-- pings a small URL set every 5 minutes, alerts on TWO consecutive failures
-- per URL (transient single failures don't page), and emails a recovery
-- notification on the failure->success transition. State per URL lives in
-- the `uptime_alerts` table below; the per-tick ping trail is appended to
-- `audit_log` (action='uptime_check'), and alert/recovery dispatches get
-- their own audit_action values for SOC 2 CC7.2 (System Monitoring).
--
-- WHY a dedicated state table (instead of deriving consecutive_failures
-- from audit_log on each tick): keeps the cron O(1) on table size, and
-- makes "alert was sent at X, hasn't recovered yet" a single row read
-- instead of a window query. Schema is intentionally minimal: this is ops
-- infrastructure, not customer data.
--
-- WHY no rollback for the enum values: PostgreSQL cannot remove ENUM
-- values without recreating the type and rewriting every dependent column.
-- The route that emits these values ships in the same PR; an orphan enum
-- value is harmless (just unused).
--
-- @security SOC 2 CC7.2 (System Monitoring) — durable trail of uptime
--   pings + alert dispatch decisions. Operators can audit "was prod
--   actually down at the time the customer reported it?"

-- 1) audit_action enum values for the uptime cron's three log row types.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'uptime_check';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'uptime_alert';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'uptime_recovery';

-- 2) Per-URL alert state. One row per monitored URL. The cron upserts on
-- every tick.
--
-- consecutive_failures: number of back-to-back failed pings since the last
--   success. Reset to 0 on a successful tick. Alert fires when this
--   transitions to >= 2 AND alert_sent_at is older than the throttle
--   window (1 hour, enforced in the route, not the schema).
--
-- alert_sent_at: timestamp of the last alert email. NULL means we are
--   either healthy or have never alerted. Used by the route to throttle
--   repeat alerts during a sustained outage.
--
-- recovery_sent_at: timestamp of the last recovery email. NULL until the
--   first failure->success transition fires after an alert. Used to avoid
--   double-sending recovery emails (one per outage, not one per tick).
--
-- WHY url is the PRIMARY KEY: there is exactly one state row per
-- monitored URL. This makes the upsert trivial and prevents drift.
CREATE TABLE IF NOT EXISTS uptime_alerts (
  url TEXT PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  alert_sent_at TIMESTAMPTZ,
  recovery_sent_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The route reads "currently alerting" rows to decide what to render in
-- ops dashboards. Index lets that filter stay sub-millisecond as the URL
-- list grows.
CREATE INDEX IF NOT EXISTS idx_uptime_alerts_alerting
  ON uptime_alerts(alert_sent_at)
  WHERE alert_sent_at IS NOT NULL AND recovery_sent_at IS NULL;

-- RLS: this table is operator-only. No user-facing reads. The admin client
-- bypasses RLS via service-role key, so we lock down the public path.
ALTER TABLE uptime_alerts ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for non-service roles = nobody
-- but the service role can touch this table. Explicit deny-by-default.
COMMENT ON TABLE uptime_alerts IS
  'Per-URL uptime monitor state. Service-role only. Updated by /api/cron/uptime-monitor.';
