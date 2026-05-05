-- Migration 080: OpenRouter credit-monitor cron audit_action enum values
--
-- WHY: packages/styrby-web/src/app/api/cron/openrouter-credit-monitor/route.ts
-- runs daily, polls https://openrouter.ai/api/v1/credits, and writes one of two
-- audit_log rows per invocation:
--   • openrouter_credit_check — every run (forensic + observability trail of
--     remaining balance, threshold, and whether an alert was dispatched).
--   • openrouter_low_balance_alert — written ONLY when the route also dispatches
--     an email alert. Used by the route itself to throttle (skip alerts when
--     a row exists in the last 24h), preventing alert-storm during a sustained
--     low-balance window.
--
-- Without these enum values the audit_log INSERT in the route handler fails
-- with "invalid input value for enum audit_action", which would silently break
-- both the observability trail AND the throttle (route would alert every run).
--
-- WHY no rollback: ENUM values cannot be removed in PostgreSQL without
-- recreating the type and rewriting every dependent column. The route code that
-- emits these values ships in the same PR; if the migration applies but the
-- code rolls back, the values are simply unused (no harm).
--
-- @security SOC 2 CC7.2 (System Monitoring) — establishes durable trail of
--   third-party credit balance + alert dispatch decisions.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'openrouter_credit_check';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'openrouter_low_balance_alert';
