-- ============================================================================
-- MIGRATION 010: Expand mv_daily_cost_summary to include model dimension
-- ============================================================================
--
-- WHY: The costs dashboard was hitting the raw cost_records table for per-agent
-- and per-model breakdowns, forcing a full table scan of up to 10,000 rows on
-- every page load. By adding `model` as a grouping dimension to the materialized
-- view, all breakdowns can be derived from the pre-aggregated MV — eliminating
-- the raw table scan entirely.
--
-- CHANGES:
--   1. Drop and recreate mv_daily_cost_summary with (user_id, record_date, agent_type, model)
--   2. Rename total_cost -> total_cost_usd for consistency with query expectations
--   3. Recreate unique index on the new composite key (required for REFRESH CONCURRENTLY)
--   4. Grant SELECT to authenticated role
-- ============================================================================

-- Drop the old view (and its index, which is dropped automatically)
DROP MATERIALIZED VIEW IF EXISTS mv_daily_cost_summary;

-- Recreate with agent_type + model as grouping dimensions.
-- WHY column rename: the costs page expects `total_cost_usd`; the old view used
-- `total_cost`. Fixing the name here removes any column-name mismatch bugs.
CREATE MATERIALIZED VIEW mv_daily_cost_summary AS
SELECT
  user_id,
  record_date,
  agent_type,
  model,
  COUNT(*)                    AS record_count,
  SUM(input_tokens)           AS total_input_tokens,
  SUM(output_tokens)          AS total_output_tokens,
  SUM(cache_read_tokens)      AS total_cache_read_tokens,
  SUM(cost_usd)               AS total_cost_usd
FROM cost_records
GROUP BY user_id, record_date, agent_type, model
ORDER BY record_date DESC;

-- Unique index on the new composite key — required for REFRESH CONCURRENTLY.
-- WHY CONCURRENTLY: allows refresh without locking reads, so the dashboard
-- remains responsive while the nightly cron updates the view.
CREATE UNIQUE INDEX idx_mv_daily_cost_user_date_agent_model
  ON mv_daily_cost_summary (user_id, record_date, agent_type, model);

-- Grant read access to authenticated Supabase users.
-- WHY: RLS on the underlying cost_records table already filters by user_id,
-- but the MV is not subject to RLS — we rely on application-layer filtering
-- (.eq('user_id', user.id)) and restrict access to authenticated role only.
GRANT SELECT ON mv_daily_cost_summary TO authenticated;
