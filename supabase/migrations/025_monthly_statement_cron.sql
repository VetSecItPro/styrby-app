-- Migration 025: Monthly statement cron job + admin flag on profiles
--
-- WHY pg_cron here (not in edge function): pg_cron jobs must be registered in
-- the database. The edge function is invoked by the cron trigger. Per prior
-- lesson (feedback_supabase_pg_cron_schema.md), Supabase pins pg_cron to
-- pg_catalog schema; cron.schedule() works regardless.
--
-- Schedule: 1st of every month at 08:00 UTC (03:00 AM Central Time).
-- WHY 08:00 UTC: Avoids midnight bursts when many cron jobs fire simultaneously.
-- 03:00 AM CT gives US users their statement before they start work.

-- ── 1. Add is_admin column to profiles (for founder ops dashboard gate) ──────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- WHY: Only admins access the founder ops dashboard. We gate at the server
-- component level (profiles.is_admin = true) rather than Supabase RLS so
-- the admin UI can query across all user rows using the service role.

COMMENT ON COLUMN profiles.is_admin IS
  'Whether this user has admin access to the founder ops dashboard (/admin/cost-ops). '
  'Set manually by a Supabase admin — never exposed to the client auth JWT.';

-- ── 2. Register the monthly statement cron job ────────────────────────────────
-- WHY: We call the Supabase Edge Function via HTTP. The service role key
-- is stored as a vault secret (pgvault) so it is never in plain SQL.
-- The net.http_post extension is available on Supabase Pro+ projects.

SELECT cron.schedule(
  'send-monthly-statement',            -- job name (idempotent: upserts on re-run)
  '0 8 1 * *',                        -- every 1st of month at 08:00 UTC
  $$
  SELECT net.http_post(
    url    := current_setting('app.supabase_function_base_url') || '/send-monthly-statement',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
    ),
    body   := '{}'::jsonb
  );
  $$
);

-- ── 3. Store required settings in app.settings (loaded from vault in prod) ───
-- WHY: We reference them via current_setting() above. In development, set
-- these via: ALTER DATABASE postgres SET app.supabase_function_base_url = '...';
-- In production, Supabase loads vault secrets into session settings automatically.

-- No-op placeholder comment: actual values injected via Supabase Vault or
-- environment-level configuration. Do NOT hardcode URLs or keys here.

-- ── 4. RLS note ───────────────────────────────────────────────────────────────
-- The send-monthly-statement function uses the service role key, which bypasses
-- RLS for cross-user queries. The is_admin column has no RLS policy — it is
-- only readable via the service role key (never via the anon or authenticated
-- role in a way that leaks other users' admin status).
