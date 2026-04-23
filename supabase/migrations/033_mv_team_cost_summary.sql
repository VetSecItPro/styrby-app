-- ============================================================================
-- Migration 033: mv_team_cost_summary Materialized View (Phase 2.5)
-- ============================================================================
--
-- WHY a dedicated team MV instead of querying mv_daily_cost_summary directly:
--   mv_daily_cost_summary is per-user, and team cost rollup requires joining
--   across multiple user_ids (all team members). RLS prevents direct cross-user
--   queries from the browser. A service-role-refreshed MV pre-aggregates the
--   join and exposes it via the existing get_team_cost_summary RPC pattern.
--
-- WHY per-team per-day granularity:
--   The team cost dashboard shows stacked bar charts by day. Per-day rows give
--   the chart data it needs while staying small enough for fast queries. Further
--   sub-division (e.g. per-hour) would bloat the MV without adding chart value.
--
-- WHY agent_type column in the rollup:
--   The stacked bar chart is stacked BY agent_type. Without agent_type in the
--   MV, the chart component would need to issue one query per agent — N+1.
--   Including agent_type in the GROUP BY serves the chart in a single scan.
--
-- WHY pg_cron hourly refresh (not continuous):
--   Team cost analytics is a planning tool, not a real-time monitor. Hourly
--   staleness is acceptable for the "how are we tracking this month?" use case.
--   Continuous aggregate would require TimescaleDB (not available on Supabase
--   Postgres). Hourly cron is the lightest-weight alternative.
--
-- WHY SECURITY DEFINER on the accessor RPC:
--   The MV lives outside RLS. get_team_cost_summary_v2 (below) is the gated
--   entry point. It verifies the caller is a member of p_team_id before
--   returning rows, matching the pattern established in migration 006.
--
-- SOC2 CC6.3: Access to aggregated cost data is restricted to team members.
--   The SECURITY DEFINER function enforces this at the DB layer, defence-in-
--   depth against any future RLS misconfiguration on the base MV.
-- ============================================================================

-- ============================================================================
-- 1. Materialized View
-- ============================================================================

-- WHY DROP + CREATE (not CREATE OR REPLACE): Postgres does not support
-- OR REPLACE for materialized views; we must drop and recreate if the
-- definition changes. IF EXISTS keeps the migration idempotent for re-runs.
DROP MATERIALIZED VIEW IF EXISTS mv_team_cost_summary;

CREATE MATERIALIZED VIEW mv_team_cost_summary AS
SELECT
  tm.team_id,
  cr.user_id                                           AS member_user_id,
  cr.record_date,
  cr.agent_type,
  SUM(cr.cost_usd)::NUMERIC(12, 6)                    AS total_cost_usd,
  SUM(cr.input_tokens)::BIGINT                         AS total_input_tokens,
  SUM(cr.output_tokens)::BIGINT                        AS total_output_tokens,
  COUNT(*)::BIGINT                                     AS record_count
FROM cost_records cr
JOIN team_members tm ON tm.user_id = cr.user_id
GROUP BY
  tm.team_id,
  cr.user_id,
  cr.record_date,
  cr.agent_type;

-- WHY non-unique: the same (team_id, member_user_id, record_date, agent_type)
-- is unique by construction (GROUP BY), but we declare non-unique to
-- allow for potential future partial refreshes without constraint errors.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_team_cost_summary_pk
  ON mv_team_cost_summary (team_id, member_user_id, record_date, agent_type);

-- Secondary index for the common query pattern: all rows for a given team
-- within a date range, without filtering by member or agent.
CREATE INDEX IF NOT EXISTS idx_mv_team_cost_summary_team_date
  ON mv_team_cost_summary (team_id, record_date DESC);

-- Index to support per-member queries (admin view: "show me Alice's spend").
CREATE INDEX IF NOT EXISTS idx_mv_team_cost_summary_member
  ON mv_team_cost_summary (team_id, member_user_id, record_date DESC);

COMMENT ON MATERIALIZED VIEW mv_team_cost_summary IS
  'Pre-aggregated per-team per-member per-day per-agent cost rollup. '
  'Refreshed hourly by pg_cron job added in migration 033. '
  'Consumed by get_team_cost_summary_v2() and the /api/teams/[id]/costs route. '
  'Phase 2.5.';

-- ============================================================================
-- 2. Hourly pg_cron refresh job
-- ============================================================================
-- WHY schedule at minute :05: Offset from the top of the hour so the MV
-- refresh does not compete with other cron jobs (e.g. pg_cron defaults at :00).
-- WHY pg_catalog.cron: Supabase pins pg_cron to pg_catalog (not the extensions
-- schema). Referencing pg_catalog.cron.schedule() is required per project
-- memory feedback_supabase_pg_cron_schema.md.

SELECT pg_catalog.cron.schedule(
  'refresh-mv-team-cost-summary',
  '5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_team_cost_summary$$
);

-- ============================================================================
-- 3. Accessor RPC: get_team_cost_summary_v2
-- ============================================================================
-- Replaces the stub pattern used in team-costs.tsx (which called
-- get_team_cost_summary — a function that may not yet exist in the DB).
-- This v2 function queries the new MV and is the authoritative entry point.
--
-- WHY "v2" naming: get_team_cost_summary was referenced in UI code without
-- a prior DB function declaration. v2 gives us a clean break; callers can
-- migrate from the old name to v2 without risk of naming collision.
--
-- WHY date-range parameters (p_start_date, p_end_date optional):
--   Callers pass the same range start the user selected in the UI (7/30/90d).
--   Defaulting p_end_date to CURRENT_DATE keeps the API simple for most callers.

CREATE OR REPLACE FUNCTION get_team_cost_summary_v2(
  p_team_id   UUID,
  p_start_date DATE,
  p_end_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  user_id             UUID,
  display_name        TEXT,
  email               TEXT,
  total_cost_usd      NUMERIC,
  total_input_tokens  BIGINT,
  total_output_tokens BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY: Verify the calling user is a member of p_team_id.
  -- WHY: This function runs with SECURITY DEFINER (elevated privileges).
  -- Without this check any authenticated user could call it with any team_id.
  IF NOT EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = p_team_id AND user_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'Not a member of team %', p_team_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    mv.member_user_id                       AS user_id,
    COALESCE(p.display_name, u.email)       AS display_name,
    u.email,
    SUM(mv.total_cost_usd)::NUMERIC         AS total_cost_usd,
    SUM(mv.total_input_tokens)::BIGINT      AS total_input_tokens,
    SUM(mv.total_output_tokens)::BIGINT     AS total_output_tokens
  FROM mv_team_cost_summary mv
  JOIN auth.users u ON u.id = mv.member_user_id
  LEFT JOIN profiles p ON p.id = mv.member_user_id
  WHERE
    mv.team_id = p_team_id
    AND mv.record_date BETWEEN p_start_date AND p_end_date
  GROUP BY
    mv.member_user_id,
    p.display_name,
    u.email
  ORDER BY total_cost_usd DESC;
END;
$$;

-- ============================================================================
-- 4. Accessor RPC: get_team_cost_by_agent
-- ============================================================================
-- Returns per-agent daily cost rows for the stacked bar chart.
-- Separate from get_team_cost_summary_v2 so the chart component gets
-- the granular (date, agent_type) data it needs without over-fetching.
--
-- WHY also team-membership-gated: same security posture as v2 above.

CREATE OR REPLACE FUNCTION get_team_cost_by_agent(
  p_team_id    UUID,
  p_start_date DATE,
  p_end_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  record_date          DATE,
  agent_type           TEXT,
  total_cost_usd       NUMERIC,
  total_input_tokens   BIGINT,
  total_output_tokens  BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY: membership gate (identical to get_team_cost_summary_v2).
  IF NOT EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = p_team_id AND user_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'Not a member of team %', p_team_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    mv.record_date,
    mv.agent_type,
    SUM(mv.total_cost_usd)::NUMERIC        AS total_cost_usd,
    SUM(mv.total_input_tokens)::BIGINT     AS total_input_tokens,
    SUM(mv.total_output_tokens)::BIGINT    AS total_output_tokens
  FROM mv_team_cost_summary mv
  WHERE
    mv.team_id = p_team_id
    AND mv.record_date BETWEEN p_start_date AND p_end_date
  GROUP BY
    mv.record_date,
    mv.agent_type
  ORDER BY
    mv.record_date ASC,
    mv.agent_type;
END;
$$;

-- ============================================================================
-- 5. Grants
-- ============================================================================
-- WHY: SECURITY DEFINER functions need EXECUTE granted to authenticated users.
-- The service_role already has superuser privileges and does not need explicit grants.

GRANT EXECUTE ON FUNCTION get_team_cost_summary_v2(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION get_team_cost_by_agent(UUID, DATE, DATE)    TO authenticated;

-- ============================================================================
-- 6. Projected MTD vs seat-budget helper view
-- ============================================================================
-- WHY a view (not an MV or function): The projection is cheap to compute
-- from the current MV data + team columns added in migration 031. A regular
-- view keeps it auto-refreshed (no cron needed) at the cost of a live scan —
-- acceptable because this view is only queried once per page load.
--
-- WHY expose via /api/teams/[id]/costs (not RPC): The route layer can use
-- Supabase createAdminClient() to query this view server-side and return the
-- projection JSON to the browser. Keeps browser exposure minimal.

CREATE OR REPLACE VIEW v_team_cost_projection AS
SELECT
  mv.team_id,
  t.name                                            AS team_name,
  t.billing_tier,
  t.active_seats,
  -- Budget: seat count × per-seat monthly budget (hardcoded per tier for now)
  -- WHY hardcoded: pricing lives in @styrby/shared/pricing; the DB view uses
  -- a simple CASE because we can't call TypeScript from SQL. Phase 3 can
  -- parameterise this if tier pricing changes frequently.
  CASE t.billing_tier
    WHEN 'team'     THEN t.active_seats * 19.00
    WHEN 'business' THEN t.active_seats * 39.00
    ELSE                 t.active_seats * 19.00   -- default to team rate
  END::NUMERIC(12, 2)                               AS seat_budget_usd,

  -- MTD spend: sum from MV for the current calendar month
  COALESCE(
    SUM(mv.total_cost_usd) FILTER (
      WHERE mv.record_date >= DATE_TRUNC('month', CURRENT_DATE)::DATE
    ),
    0
  )::NUMERIC(12, 6)                                 AS mtd_spend_usd,

  -- Days elapsed / total days in month for projection
  EXTRACT(DAY FROM CURRENT_DATE)::INT               AS days_elapsed,
  EXTRACT(DAY FROM (
    DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'
  ))::INT                                           AS days_in_month

FROM mv_team_cost_summary mv
JOIN teams t ON t.id = mv.team_id
GROUP BY
  mv.team_id,
  t.name,
  t.billing_tier,
  t.active_seats;

COMMENT ON VIEW v_team_cost_projection IS
  'Per-team MTD spend vs seat-budget projection. Derived from mv_team_cost_summary + '
  'teams.active_seats + teams.billing_tier (populated by migration 031 Phase 2.6 webhooks). '
  'Queried server-side by /api/teams/[id]/costs. Phase 2.5.';

-- Service role can read the projection view for the API route
GRANT SELECT ON v_team_cost_projection TO service_role;

-- ============================================================================
-- END OF MIGRATION 033
-- ============================================================================
