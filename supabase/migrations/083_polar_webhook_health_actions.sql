-- Migration 083: Polar webhook health-monitor cron audit_action enum values
--
-- WHY: packages/styrby-web/src/app/api/cron/polar-webhook-health/route.ts runs
-- hourly, inspects the polar_webhook_events table + recent webhook-guard
-- audit_log rows, and writes one of two audit_log rows per invocation:
--   • polar_webhook_health_check  — every run (forensic + observability trail
--     of last-event timestamp, 24h volume, and signal evaluation outcomes).
--   • polar_webhook_health_alert  — written ONLY when a health signal trips
--     AND no prior alert of that signal exists in the throttle window. Used
--     by the route itself to throttle (skip duplicate alerts when a row
--     exists in the last 24h), preventing alert-storm during a sustained
--     incident (Polar outage, our endpoint broken, config drift).
--
-- Without these enum values the audit_log INSERT in the route handler fails
-- with "invalid input value for enum audit_action", which would silently
-- break both the observability trail AND the throttle (route would alert
-- every hour).
--
-- WHY no rollback: ENUM values cannot be removed in PostgreSQL without
-- recreating the type and rewriting every dependent column. The route code
-- that emits these values ships in the same PR; if the migration applies
-- but the code rolls back, the values are simply unused (no harm).
--
-- @security SOC 2 CC7.2 (System Monitoring) — establishes durable trail of
--   billing-pipeline health checks + alert dispatch decisions. Polar webhook
--   silence is a billing-correctness event (subscription state can drift if
--   we miss a subscription.canceled), so health monitoring is a control.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'polar_webhook_health_check';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'polar_webhook_health_alert';
